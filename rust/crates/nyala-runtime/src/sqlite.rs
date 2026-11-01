/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! SQLite database files for `connection.test` and `connection.open` (N-104): path checks,
//! opening in the requested mode, and the probe that tells a database from any other file.
//!
//! A failure becomes an [`RpcError`] whose `safeDetail` names the cause but never the path,
//! because paths can contain user names (`nyala/rpc/README.md` §7). SQLite's own messages are not
//! forwarded for the same reason: for `SQLITE_CANTOPEN`, rusqlite appends the path. The mapping
//! onto the v1 error table is recorded in `docs/adr/0002-rust-runtime-workspace.md`.

use std::fmt;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, ErrorCode, OpenFlags, MAIN_DB};

use crate::error::{ErrorKind, RpcError};

/// How long opening waits on a lock held by another connection before it fails with
/// `QUERY_TIMEOUT`. The runtime serves one request at a time, so this also bounds how long other
/// requests wait.
pub const OPEN_BUSY_TIMEOUT: Duration = Duration::from_secs(2);

/// Version of the bundled SQLite library, reported as `serverVersion`.
pub fn library_version() -> &'static str {
	rusqlite::version()
}

/// An open SQLite connection.
pub struct Database {
	connection: Connection,
	read_only: bool,
}

// Written out by hand because rusqlite's `Connection` prints the file path in its `Debug` output.
impl fmt::Debug for Database {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("Database")
			.field("read_only", &self.read_only)
			.finish_non_exhaustive()
	}
}

impl Database {
	/// Opens the existing database file that `path` names.
	///
	/// `path` must be an absolute path to a regular local file, or to a link that resolves to one.
	/// Nothing is created. The file must pass the probe, and a read-write request must get write
	/// access.
	pub fn open(path: &str, read_only: bool) -> Result<Database, RpcError> {
		let path = resolve(path)?;
		check_read_access(&path)?;

		// Without SQLITE_OPEN_CREATE, a missing file is an error and never becomes a new
		// database. The path is canonical, so it cannot start with `file:` and SQLite never
		// parses it as a URI (the bundled build turns URI filenames on globally). NOFOLLOW makes
		// SQLite refuse the path if a symbolic link was added to it after it was resolved; SQLite
		// checks for this on Unix only.
		let mode = if read_only {
			OpenFlags::SQLITE_OPEN_READ_ONLY
		} else {
			OpenFlags::SQLITE_OPEN_READ_WRITE
		};
		let flags = mode | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_NOFOLLOW;
		let connection = Connection::open_with_flags(&path, flags).map_err(open_error)?;

		// When SQLite may not write a file, it opens it read-only instead of failing. A
		// read-write session must not be reported for such a file.
		let opened_read_only = connection.is_readonly(MAIN_DB).map_err(open_error)?;
		if opened_read_only && !read_only {
			return Err(RpcError::with_detail(
				ErrorKind::PermissionDenied,
				"the database file is not writable",
			));
		}

		connection
			.busy_timeout(OPEN_BUSY_TIMEOUT)
			.map_err(open_error)?;
		// sqlite3_open_v2 does not read the file. Reading the schema table parses the header,
		// page 1 and every schema entry, which is where a different file type or a damaged
		// file shows up.
		connection
			.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
			.map_err(open_error)?;

		Ok(Database {
			connection,
			read_only: opened_read_only,
		})
	}

	/// Whether SQLite opened the file read-only.
	pub fn read_only(&self) -> bool {
		self.read_only
	}

	/// Closes the connection. If closing fails, the database is still open and is returned
	/// together with the error.
	pub fn close(self) -> Result<(), (Database, RpcError)> {
		let Database {
			connection,
			read_only,
		} = self;
		connection.close().map_err(|(connection, _)| {
			let error = RpcError::with_detail(
				ErrorKind::Internal,
				"the SQLite connection could not be closed",
			);
			(
				Database {
					connection,
					read_only,
				},
				error,
			)
		})
	}
}

/// Checks the requested path and resolves it to the regular file it names.
fn resolve(requested: &str) -> Result<PathBuf, RpcError> {
	if requested.contains('\0') {
		return Err(invalid("path must not contain NUL"));
	}
	if requested == ":memory:"
		|| requested
			.get(..5)
			.is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:"))
	{
		return Err(invalid("in-memory and URI databases are not supported"));
	}
	if !is_local_absolute(Path::new(requested)) {
		return Err(invalid("path must be an absolute local file path"));
	}

	// canonicalize follows symbolic links, so the checks below apply to the file a link points to.
	let resolved =
		fs::canonicalize(requested).map_err(|error| io_error(&error, "path cannot be resolved"))?;
	if !is_local_canonical(&resolved) {
		return Err(invalid("network and device paths are not supported"));
	}
	let metadata =
		fs::metadata(&resolved).map_err(|error| io_error(&error, "path cannot be resolved"))?;
	if metadata.is_dir() {
		return Err(invalid("path is a directory"));
	}
	if !metadata.is_file() {
		return Err(invalid("path is not a regular file"));
	}
	// SQLite treats an empty file as an empty database and passes the probe. The runtime opens
	// existing databases only, and an empty file has never been one.
	if metadata.len() == 0 {
		return Err(invalid("file is empty"));
	}
	Ok(resolved)
}

/// Opens the file for reading, so that a refusal by the operating system is reported as
/// `PERMISSION_DENIED`. SQLite would only report that it cannot open the file.
fn check_read_access(path: &Path) -> Result<(), RpcError> {
	File::open(path)
		.map(drop)
		.map_err(|error| io_error(&error, "file cannot be opened"))
}

/// Accepts drive-absolute paths (`C:\…`) only. A UNC path (`\\server\share\…`) makes Windows open
/// an SMB connection, which can send the user's NTLM credentials to that host; device paths
/// (`\\?\…`, `\\.\…`) bypass path normalization; `C:foo` and `\foo` are relative.
#[cfg(windows)]
fn is_local_absolute(path: &Path) -> bool {
	use std::path::{Component, Prefix};
	let mut components = path.components();
	match (components.next(), components.next()) {
		(Some(Component::Prefix(prefix)), Some(Component::RootDir)) => {
			matches!(prefix.kind(), Prefix::Disk(_))
		}
		_ => false,
	}
}

#[cfg(not(windows))]
fn is_local_absolute(path: &Path) -> bool {
	path.is_absolute()
}

/// canonicalize returns `\\?\C:\…` for a local file and `\\?\UNC\…` for a file on a network
/// share, which is refused here. A share reached through a symbolic link or a mapped drive letter
/// has already been contacted by canonicalize at this point; the ADR records this as a known gap.
#[cfg(windows)]
fn is_local_canonical(path: &Path) -> bool {
	use std::path::{Component, Prefix};
	matches!(
		path.components().next(),
		Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::VerbatimDisk(_))
	)
}

#[cfg(not(windows))]
fn is_local_canonical(_: &Path) -> bool {
	true
}

fn io_error(error: &io::Error, other: &str) -> RpcError {
	match error.kind() {
		io::ErrorKind::NotFound => invalid("file does not exist"),
		io::ErrorKind::PermissionDenied => RpcError::with_detail(
			ErrorKind::PermissionDenied,
			"the operating system denied access to the file",
		),
		_ => invalid(other),
	}
}

/// Maps a SQLite failure while opening or probing onto the v1 error table.
fn open_error(error: rusqlite::Error) -> RpcError {
	if matches!(error, rusqlite::Error::InvalidPath(_)) {
		return invalid("path cannot be passed to SQLite");
	}
	let Some(code) = error.sqlite_error_code() else {
		return RpcError::with_detail(ErrorKind::Internal, "unexpected SQLite driver error");
	};
	let (kind, detail) = match code {
		ErrorCode::NotADatabase => (ErrorKind::InvalidParams, "file is not a SQLite database"),
		ErrorCode::DatabaseCorrupt => (ErrorKind::InvalidParams, "database file is corrupt"),
		ErrorCode::CannotOpen => (ErrorKind::InvalidParams, "database file cannot be opened"),
		ErrorCode::PermissionDenied | ErrorCode::ReadOnly => (
			ErrorKind::PermissionDenied,
			"the database file cannot be accessed in the requested mode",
		),
		ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => (
			ErrorKind::QueryTimeout,
			"database is locked by another connection",
		),
		_ => {
			return RpcError::with_detail(
				ErrorKind::Internal,
				format!("unexpected SQLite error {code:?}"),
			)
		}
	};
	RpcError::with_detail(kind, detail)
}

fn invalid(detail: &str) -> RpcError {
	RpcError::with_detail(ErrorKind::InvalidParams, detail)
}

#[cfg(test)]
mod tests {
	use super::test_files::{text, NoAccess, ReadOnly, TempDir};
	use super::*;
	use rusqlite::ffi;

	#[test]
	fn memory_uri_relative_and_nul_paths_are_refused_before_the_file_system_is_touched() {
		for path in [
			":memory:",
			"file:db.sqlite",
			"FILE:///tmp/db.sqlite",
			"file:C:/db.sqlite?mode=rwc",
			"db.sqlite",
			"./db.sqlite",
			"../db.sqlite",
			"~/db.sqlite",
			"/tmp/db\0.sqlite",
		] {
			let error = resolve(path).expect_err(path);
			assert_eq!(error.kind, ErrorKind::InvalidParams, "{path:?}");
		}
	}

	#[cfg(windows)]
	#[test]
	fn windows_accepts_drive_absolute_paths_only() {
		for path in [r"C:\data\db.sqlite", "C:/data/db.sqlite", r"d:\db.sqlite"] {
			assert!(is_local_absolute(Path::new(path)), "{path}");
		}
		for path in [
			r"\\server\share\db.sqlite",
			"//server/share/db.sqlite",
			r"\\?\C:\db.sqlite",
			r"\\?\UNC\server\share\db.sqlite",
			r"\\.\C:\db.sqlite",
			r"\\.\pipe\db",
			"C:db.sqlite",
			r"\db.sqlite",
			"/db.sqlite",
			"db.sqlite",
		] {
			assert!(!is_local_absolute(Path::new(path)), "{path}");
		}
	}

	#[cfg(windows)]
	#[test]
	fn windows_refuses_canonical_paths_outside_local_drives() {
		assert!(is_local_canonical(Path::new(r"\\?\C:\data\db.sqlite")));
		for path in [
			r"\\?\UNC\server\share\db.sqlite",
			r"\\server\share\db.sqlite",
			r"\\.\NUL",
			r"C:\data\db.sqlite",
		] {
			assert!(!is_local_canonical(Path::new(path)), "{path}");
		}
	}

	#[test]
	fn sqlite_failures_map_to_the_v1_table_without_their_message() {
		let cases = [
			(ffi::SQLITE_NOTADB, ErrorKind::InvalidParams),
			(ffi::SQLITE_CORRUPT, ErrorKind::InvalidParams),
			(ffi::SQLITE_CANTOPEN, ErrorKind::InvalidParams),
			(ffi::SQLITE_PERM, ErrorKind::PermissionDenied),
			(ffi::SQLITE_READONLY, ErrorKind::PermissionDenied),
			(ffi::SQLITE_BUSY, ErrorKind::QueryTimeout),
			(ffi::SQLITE_LOCKED, ErrorKind::QueryTimeout),
			(ffi::SQLITE_IOERR, ErrorKind::Internal),
			(ffi::SQLITE_NOMEM, ErrorKind::Internal),
		];
		for (code, kind) in cases {
			let error = rusqlite::Error::SqliteFailure(
				ffi::Error::new(code),
				Some("unable to open database file: /home/alice/db.sqlite".into()),
			);
			let mapped = open_error(error);
			assert_eq!(mapped.kind, kind, "SQLite code {code}");
			assert!(!mapped.to_string().contains("alice"), "{mapped}");
		}
		let invalid_path = open_error(rusqlite::Error::InvalidPath("/home/alice".into()));
		assert_eq!(invalid_path.kind, ErrorKind::InvalidParams);
		assert!(!invalid_path.to_string().contains("alice"));
	}

	fn refusal(path: &Path, read_only: bool) -> (ErrorKind, String) {
		let error = Database::open(text(path), read_only).expect_err(text(path));
		(error.kind, error.safe_detail.unwrap_or_default())
	}

	#[test]
	fn existing_databases_open_in_the_requested_mode() {
		let dir = TempDir::new("modes");
		let path = dir.database("db.sqlite");
		for read_only in [true, false] {
			let database = Database::open(text(&path), read_only).unwrap();
			assert_eq!(database.read_only(), read_only);
			database.close().unwrap();
		}
	}

	#[test]
	fn missing_files_are_refused_and_never_created() {
		let dir = TempDir::new("missing");
		let path = dir.join("missing.sqlite");
		for read_only in [true, false] {
			assert_eq!(
				refusal(&path, read_only),
				(ErrorKind::InvalidParams, "file does not exist".into())
			);
		}
		assert!(dir.entries().is_empty(), "{:?}", dir.entries());
	}

	#[test]
	fn directories_empty_files_and_other_files_are_refused() {
		let dir = TempDir::new("files");
		let cases = [
			(dir.folder("folder"), "path is a directory"),
			(dir.file("empty.sqlite", b""), "file is empty"),
			(dir.text_file("notes.txt"), "file is not a SQLite database"),
			(
				dir.damaged_header("header.sqlite"),
				"file is not a SQLite database",
			),
			(
				dir.truncated("truncated.sqlite", 50),
				"database file is corrupt",
			),
			(
				dir.truncated_to_half("half.sqlite"),
				"database file is corrupt",
			),
		];
		let before = dir.entries();
		for (path, detail) in &cases {
			for read_only in [true, false] {
				assert_eq!(
					refusal(path, read_only),
					(ErrorKind::InvalidParams, (*detail).into()),
					"{path:?} read_only={read_only}"
				);
			}
		}
		assert_eq!(
			dir.entries(),
			before,
			"no journal or other file is left behind"
		);
	}

	#[test]
	fn a_read_write_request_for_a_read_only_file_is_refused() {
		let dir = TempDir::new("read-only");
		let path = dir.database("db.sqlite");
		let Some(_read_only) = ReadOnly::set(&path) else {
			// Root can write any file on Unix, so there is no downgrade to observe.
			return;
		};
		assert_eq!(
			refusal(&path, false),
			(
				ErrorKind::PermissionDenied,
				"the database file is not writable".into()
			)
		);
		let database = Database::open(text(&path), true).unwrap();
		assert!(database.read_only());
	}

	#[cfg(unix)]
	#[test]
	fn links_are_followed_and_their_target_is_checked() {
		use std::os::unix::fs::symlink;

		let dir = TempDir::new("links");
		let database = dir.database("db.sqlite");
		let folder = dir.folder("folder");
		let to_database = dir.join("to-database");
		let to_folder = dir.join("to-folder");
		let dangling = dir.join("dangling");
		symlink(&database, &to_database).unwrap();
		symlink(&folder, &to_folder).unwrap();
		symlink(dir.join("gone.sqlite"), &dangling).unwrap();

		Database::open(text(&to_database), true)
			.unwrap()
			.close()
			.unwrap();
		let cases = [
			(to_folder.as_path(), "path is a directory"),
			(dangling.as_path(), "file does not exist"),
			(Path::new("/dev/null"), "path is not a regular file"),
		];
		for (path, detail) in cases {
			assert_eq!(
				refusal(path, true),
				(ErrorKind::InvalidParams, detail.into()),
				"{path:?}"
			);
		}
	}

	#[test]
	fn a_file_the_operating_system_will_not_let_us_read_is_permission_denied() {
		let dir = TempDir::new("no-access");
		let path = dir.database("db.sqlite");
		let _no_access = match NoAccess::set(&path) {
			Ok(guard) => guard,
			Err(reason) => {
				eprintln!("skipped: cannot take read access away from the test file: {reason}");
				return;
			}
		};
		for read_only in [true, false] {
			assert_eq!(
				refusal(&path, read_only),
				(
					ErrorKind::PermissionDenied,
					"the operating system denied access to the file".into()
				),
				"read_only={read_only}"
			);
		}
	}

	/// A read-only connection to a WAL database needs the `-shm` index, so SQLite creates the
	/// `-shm` and `-wal` files next to the database when the directory is writable, and a
	/// read-only connection does not remove them when it closes. The database file itself is
	/// not written.
	#[test]
	fn a_read_only_open_of_a_wal_database_leaves_its_content_unchanged() {
		let dir = TempDir::new("wal");
		let path = dir.wal_database("wal.sqlite");
		assert_eq!(dir.entries(), ["wal.sqlite"]);
		let before = fs::read(&path).expect("read the database file");

		let database = Database::open(text(&path), true).expect("open the WAL database read-only");
		assert!(database.read_only());
		let customers: i64 = database
			.connection
			.query_row("SELECT count(*) FROM customers", [], |row| row.get(0))
			.expect("read through the read-only connection");
		assert_eq!(customers, 2);
		database.close().expect("close the WAL database");

		assert_eq!(
			fs::read(&path).expect("read the database file"),
			before,
			"a read-only open must not write the database file"
		);
		assert_eq!(
			dir.entries(),
			["wal.sqlite", "wal.sqlite-shm", "wal.sqlite-wal"],
			"the WAL auxiliary files stay behind"
		);
		assert_eq!(
			fs::metadata(dir.join("wal.sqlite-wal")).unwrap().len(),
			0,
			"no frame is written to the WAL"
		);
	}
}

/// Database files in a temporary directory for the unit tests here and in `connection`.
#[cfg(test)]
pub(crate) mod test_files {
	use std::fs::{self, File, OpenOptions, Permissions};
	use std::path::{Path, PathBuf};
	use std::process;
	#[cfg(windows)]
	use std::process::Command;
	use std::sync::atomic::{AtomicU32, Ordering};

	use rusqlite::Connection;

	/// A directory under the system temporary directory, removed when dropped.
	pub struct TempDir(PathBuf);

	impl TempDir {
		pub fn new(label: &str) -> Self {
			static NEXT: AtomicU32 = AtomicU32::new(0);
			let name = format!(
				"nyala-runtime-unit-{}-{label}-{}",
				process::id(),
				NEXT.fetch_add(1, Ordering::Relaxed)
			);
			let path = std::env::temp_dir().join(name);
			let _ = fs::remove_dir_all(&path);
			fs::create_dir_all(&path).expect("create a temporary directory");
			TempDir(path)
		}

		pub fn join(&self, name: &str) -> PathBuf {
			self.0.join(name)
		}

		/// Names of the entries in the directory, sorted.
		pub fn entries(&self) -> Vec<String> {
			let mut names: Vec<String> = fs::read_dir(&self.0)
				.expect("list the temporary directory")
				.map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
				.collect();
			names.sort();
			names
		}

		pub fn folder(&self, name: &str) -> PathBuf {
			let path = self.join(name);
			fs::create_dir(&path).expect("create a folder");
			path
		}

		pub fn file(&self, name: &str, contents: &[u8]) -> PathBuf {
			let path = self.join(name);
			fs::write(&path, contents).expect("write a test file");
			path
		}

		/// A SQLite database with a table, an index and a view, so that it spans several pages.
		pub fn database(&self, name: &str) -> PathBuf {
			let path = self.join(name);
			let connection = Connection::open(&path).expect("create a test database");
			connection
				.execute_batch(
					"CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
					INSERT INTO customers(name) VALUES ('Ada'), ('Grace');
					CREATE INDEX customers_by_name ON customers(name);
					CREATE VIEW recent_customers AS SELECT name FROM customers;",
				)
				.expect("fill the test database");
			path
		}

		/// A database in WAL mode. Closing its only connection checkpoints it and removes the
		/// `-wal` and `-shm` files, so only the database file is left.
		pub fn wal_database(&self, name: &str) -> PathBuf {
			let path = self.database(name);
			let connection = Connection::open(&path).expect("reopen the test database");
			let mode: String = connection
				.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
				.expect("switch the test database to WAL");
			assert_eq!(mode, "wal");
			drop(connection);
			path
		}

		pub fn text_file(&self, name: &str) -> PathBuf {
			self.file(name, &b"plain text, not a database\n".repeat(64))
		}

		/// A database whose 16-byte magic header string was overwritten.
		pub fn damaged_header(&self, name: &str) -> PathBuf {
			let mut bytes = fs::read(self.database(name)).expect("read the test database");
			bytes[..16].copy_from_slice(b"Not SQLite data!");
			self.file(name, &bytes)
		}

		/// A database cut to its first `length` bytes.
		pub fn truncated(&self, name: &str, length: u64) -> PathBuf {
			let path = self.database(name);
			cut(&path, length);
			path
		}

		/// A database cut to half its size, so that the page count in its header exceeds the file.
		pub fn truncated_to_half(&self, name: &str) -> PathBuf {
			let path = self.database(name);
			let length = fs::metadata(&path).expect("read the file size").len() / 2;
			cut(&path, length);
			path
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	fn cut(path: &Path, length: u64) {
		OpenOptions::new()
			.write(true)
			.open(path)
			.and_then(|file| file.set_len(length))
			.expect("truncate the test database");
	}

	/// Keeps a file read-only until dropped.
	pub struct ReadOnly {
		path: PathBuf,
		original: Permissions,
	}

	impl ReadOnly {
		/// `None` when the file stays writable, as it does for root on Unix.
		pub fn set(path: &Path) -> Option<ReadOnly> {
			let original = fs::metadata(path).expect("read permissions").permissions();
			let mut read_only = original.clone();
			read_only.set_readonly(true);
			fs::set_permissions(path, read_only).expect("make the file read-only");
			let guard = ReadOnly {
				path: path.to_owned(),
				original,
			};
			let writable = OpenOptions::new().write(true).open(path).is_ok();
			(!writable).then_some(guard)
		}
	}

	impl Drop for ReadOnly {
		fn drop(&mut self) {
			let _ = fs::set_permissions(&self.path, self.original.clone());
		}
	}

	/// Keeps the current user from reading a file until dropped.
	pub struct NoAccess {
		path: PathBuf,
		#[cfg(unix)]
		original: Permissions,
		/// `*<SID>` of the current user, as icacls takes it.
		#[cfg(windows)]
		account: String,
	}

	impl NoAccess {
		/// The reason as `Err` when access cannot be taken away, or the file stays readable as
		/// it does for root on Unix.
		pub fn set(path: &Path) -> Result<NoAccess, String> {
			let guard = Self::deny(path)?;
			match File::open(path) {
				Ok(_) => Err("the file stays readable, as it does for root".into()),
				Err(_) => Ok(guard),
			}
		}

		#[cfg(unix)]
		fn deny(path: &Path) -> Result<NoAccess, String> {
			use std::os::unix::fs::PermissionsExt;
			let original = fs::metadata(path)
				.map_err(|error| error.to_string())?
				.permissions();
			fs::set_permissions(path, Permissions::from_mode(0o000))
				.map_err(|error| error.to_string())?;
			Ok(NoAccess {
				path: path.to_owned(),
				original,
			})
		}

		/// Adds an entry that denies reading file data. A deny entry also applies to the owner,
		/// who keeps the right to change the access list and to delete the file.
		#[cfg(windows)]
		fn deny(path: &Path) -> Result<NoAccess, String> {
			let output = Command::new("whoami")
				.args(["/user", "/fo", "csv", "/nh"])
				.output()
				.map_err(|error| format!("whoami: {error}"))?;
			// `"<domain>\<user>","S-1-5-…"`
			let line = String::from_utf8_lossy(&output.stdout);
			let sid = line
				.rsplit(',')
				.next()
				.map(|sid| sid.trim().trim_matches('"'))
				.filter(|sid| sid.starts_with("S-1-"))
				.ok_or_else(|| format!("whoami printed no SID: {line}"))?;
			let account = format!("*{sid}");
			icacls(path, &["/deny", &format!("{account}:(RD)")])?;
			Ok(NoAccess {
				path: path.to_owned(),
				account,
			})
		}
	}

	impl Drop for NoAccess {
		fn drop(&mut self) {
			#[cfg(unix)]
			let _ = fs::set_permissions(&self.path, self.original.clone());
			#[cfg(windows)]
			let _ = icacls(&self.path, &["/remove:d", &self.account]);
		}
	}

	#[cfg(windows)]
	fn icacls(path: &Path, args: &[&str]) -> Result<(), String> {
		let output = Command::new("icacls")
			.arg(path)
			.args(args)
			.output()
			.map_err(|error| format!("icacls: {error}"))?;
		if output.status.success() {
			Ok(())
		} else {
			Err(format!(
				"icacls failed: {}",
				String::from_utf8_lossy(&output.stdout)
			))
		}
	}

	pub fn text(path: &Path) -> &str {
		path.to_str().expect("test paths are UTF-8")
	}
}
