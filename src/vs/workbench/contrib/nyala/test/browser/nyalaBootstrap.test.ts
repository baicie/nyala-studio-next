/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { installFakeRunWhenIdle } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Action2, isIMenuItem, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { INotificationService, NotificationMessage } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainerLocation } from '../../../../common/views.js';
import { ILifecycleService, LifecyclePhase, ShutdownReason } from '../../../../services/lifecycle/common/lifecycle.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { ITestInstantiationService, TestLifecycleService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { NYALA_ADD_SQLITE_CONNECTION_COMMAND_ID, NYALA_HELLO_COMMAND_ID, NyalaStatusContribution, addProfileForUri } from '../../bootstrap/browser/nyala.contribution.js';
import { NYALA_CONNECTIONS_VIEW_ID, NyalaConnectionsView } from '../../bootstrap/browser/nyalaConnectionsView.js';
import { INyalaCatalog, INyalaConnectionHandle, INyalaConnectionService, INyalaConnectionState, NyalaConnectionStatus } from '../../connections/common/nyalaConnectionService.js';
import { INyalaConnectionNode, NyalaConnectionNodeKind, NyalaConnectionsDataSource } from '../../connections/browser/nyalaConnectionsTree.js';
import { INyalaMetadataDescribeResult, INyalaMetadataListObjectsResult } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeContract.generated.js';
import { INyalaRuntimeState } from '../../../../../platform/nyalaRuntime/common/nyalaRuntimeIpc.js';

const NYALA_CONNECTIONS_CONTAINER_ID = 'nyala.connections.container';

/** Registers into one registry with the service-typed signature the module-level helper uses. */
function registerContribution(registry: WorkbenchContributionsRegistry): void {
	const register = registry.registerWorkbenchContribution2.bind(registry) as typeof registerWorkbenchContribution2;
	register(NyalaStatusContribution.ID, NyalaStatusContribution, WorkbenchPhase.AfterRestored);
}
const READY_MESSAGE = 'Nyala Studio Workbench is ready.';
const EMPTY_VIEW_MESSAGE = 'No connections yet. Run "Nyala: Add SQLite Connection" to open an existing database file.';

/**
 * Models a window reload: the renderer fires `onWillShutdown` with
 * `ShutdownReason.RELOAD` and then `onDidShutdown`, which is when the
 * contributions registry disposes every contribution it created.
 */
class TestReloadLifecycleService extends TestLifecycleService {

	private readonly didShutdown = this._register(new Emitter<void>());
	override get onDidShutdown(): Event<void> { return this.didShutdown.event; }

	reload(): void {
		this.fireShutdown(ShutdownReason.RELOAD);
		this.didShutdown.fire();
	}
}

class TestNyalaConnectionsView extends NyalaConnectionsView {
	renderBodyForTest(container: HTMLElement): void { this.renderBody(container); }
	layoutBodyForTest(height: number, width: number): void { this.layoutBody(height, width); }
	onDidOpenForTest(element: INyalaConnectionNode | undefined): Promise<void> { return this.onDidOpen(element); }
}

interface IRecordedStatusbarEntry {
	readonly id: string;
	readonly alignment: StatusbarAlignment;
	readonly entry: IStatusbarEntry;
}

function createStatusbar() {
	const live = new Set<IRecordedStatusbarEntry>();
	const counts = { added: 0, disposed: 0 };
	const service = {
		addEntry(entry: IStatusbarEntry, id: string, alignment: StatusbarAlignment): IStatusbarEntryAccessor {
			const record = { id, alignment, entry };
			live.add(record);
			counts.added++;
			return {
				update: () => { },
				dispose: () => {
					counts.disposed++;
					live.delete(record);
				}
			};
		}
	};
	const snapshot = () => ({
		...counts,
		live: [...live].map(({ id, alignment, entry }) => ({
			id,
			alignment,
			text: entry.text,
			command: typeof entry.command === 'string' ? entry.command : entry.command?.id
		}))
	});
	return { service, snapshot };
}

const NYALA_STATUS_ENTRY = {
	id: NyalaStatusContribution.ID,
	alignment: StatusbarAlignment.LEFT,
	text: 'Nyala',
	command: NYALA_HELLO_COMMAND_ID
};

/**
 * A Connections service the view can be driven through without a runtime: it holds the rows the
 * live service would hold and fires the same events, so the view and tree see what a real window
 * sees.
 */
class FakeConnectionService implements INyalaConnectionService {

	declare readonly _serviceBrand: undefined;

	readonly changes = new Emitter<void>();
	readonly onDidChangeConnections = this.changes.event;
	readonly runtimeChanges = new Emitter<INyalaRuntimeState>();
	readonly onDidChangeRuntime = this.runtimeChanges.event;
	readonly catalogs = new Map<string, INyalaCatalog>();
	rows: INyalaConnectionState[] = [];
	runtimeState: INyalaRuntimeState = { generation: 1, status: 'ready' };
	/** Everything the view or the tree asked this service to do, in order. */
	readonly calls: string[] = [];
	describeFailure: string | undefined;

	get connections(): readonly INyalaConnectionState[] {
		return this.rows;
	}

	setRows(rows: INyalaConnectionState[]): void {
		this.rows = rows;
		this.changes.fire();
	}

	setRuntime(state: INyalaRuntimeState): void {
		this.runtimeState = state;
		this.runtimeChanges.fire(state);
	}

	async addProfile(): Promise<string> {
		this.calls.push('addProfile');
		return 'p_1';
	}

	async restoreProfiles(): Promise<void> { }

	async refreshRuntime(): Promise<INyalaRuntimeState> {
		this.calls.push('refreshRuntime');
		return this.runtimeState;
	}

	async connect(profileId: string): Promise<void> {
		this.calls.push(`connect:${profileId}`);
	}

	async disconnect(profileId: string): Promise<void> {
		this.calls.push(`disconnect:${profileId}`);
	}

	async refresh(profileId: string): Promise<void> {
		this.calls.push(`refresh:${profileId}`);
	}

	catalog(profileId: string): INyalaCatalog | undefined {
		return this.catalogs.get(profileId);
	}

	async listObjects(): Promise<INyalaMetadataListObjectsResult> {
		throw new Error('this suite does not list objects');
	}

	async describe(_handle: INyalaConnectionHandle, object: { name: string }): Promise<INyalaMetadataDescribeResult> {
		this.calls.push(`describe:${object.name}`);
		if (this.describeFailure) {
			throw new Error(this.describeFailure);
		}
		return { columns: [{ ordinal: 0, name: 'id', nativeType: 'INTEGER', nullable: false, primaryKey: true }] };
	}

	dispose(): void {
		this.changes.dispose();
		this.runtimeChanges.dispose();
	}
}

const HANDLE: INyalaConnectionHandle = { profileId: 'p_1', sessionId: 's_1', sessionGeneration: 1, runtimeGeneration: 1 };

function profileState(status: NyalaConnectionStatus, extra: Partial<INyalaConnectionState> = {}): INyalaConnectionState {
	return {
		profile: { profileId: 'p_1', displayName: 'demo.sqlite', target: { driver: 'sqlite', path: '/tmp/demo.sqlite', readOnly: true } },
		status,
		...extra,
	};
}

/** The rows the tree currently has in the DOM, as name / description pairs. */
function renderedRows(container: HTMLElement): { name: string; description: string }[] {
	return [...container.querySelectorAll('.monaco-list-row')].map(row => ({
		name: (row.querySelector('.label-name')?.textContent ?? '').trim(),
		description: (row.querySelector('.label-description')?.textContent ?? '').trim(),
	}));
}

/** The virtualized list fills on a frame, so wait for the expected row count. */
async function whenRows(container: HTMLElement, expected: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (renderedRows(container).length !== expected) {
		if (Date.now() > deadline) {
			throw new Error(`expected ${expected} rows, saw ${JSON.stringify(renderedRows(container))}`);
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

suite('Nyala bootstrap contribution', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => {
		// Restored-phase contributions are created when idle; run them synchronously.
		store.add(installFakeRunWhenIdle((_targetWindow, runner) => {
			runner({ didTimeout: false, timeRemaining: () => 50 });
			return Disposable.None;
		}));
	});

	/**
	 * Boots one renderer: a fresh contributions registry and services, the Nyala
	 * status contribution registered as the module does, and the lifecycle driven
	 * up to `Restored`.
	 */
	async function openWindow(statusbar: ReturnType<typeof createStatusbar>) {
		const lifecycle = store.add(new TestReloadLifecycleService());
		lifecycle.usePhases = true;
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(ILifecycleService, lifecycle);
		instantiationService.stub(IStatusbarService, statusbar.service);

		const registry = store.add(new WorkbenchContributionsRegistry());
		registerContribution(registry);
		registry.start(instantiationService);
		lifecycle.phase = LifecyclePhase.Starting;
		lifecycle.phase = LifecyclePhase.Ready;
		lifecycle.phase = LifecyclePhase.Restored;
		await registry.whenRestored;

		return { lifecycle, registry };
	}

	/** A window's services, with a Connections service the test controls. */
	function createWindowServices(connections: INyalaConnectionService, overrides: (instantiationService: ITestInstantiationService) => void = () => { }): ITestInstantiationService {
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(INyalaConnectionService, connections);
		instantiationService.stub(IViewDescriptorService, new class extends mock<IViewDescriptorService>() {
			override readonly onDidChangeLocation = Event.None;
			override getViewLocationById() { return ViewContainerLocation.Sidebar; }
		}());
		overrides(instantiationService);
		return instantiationService;
	}

	function renderConnectionsView(instantiationService: ITestInstantiationService) {
		const container = append(mainWindow.document.body, $('.pane-body'));
		store.add(toDisposable(() => container.remove()));
		const view = store.add(instantiationService.createInstance(TestNyalaConnectionsView, { id: NYALA_CONNECTIONS_VIEW_ID, title: 'Connections' }));
		view.renderBodyForTest(container);
		view.layoutBodyForTest(300, 400);
		return { view, container };
	}

	test('registers the command, palette entry, view container and view exactly once', () => {
		const viewContainers = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		const views = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		const container = viewContainers.get(NYALA_CONNECTIONS_CONTAINER_ID);
		const title = MenuRegistry.getCommand(NYALA_HELLO_COMMAND_ID)?.title;

		assert.deepStrictEqual({
			command: !!CommandsRegistry.getCommand(NYALA_HELLO_COMMAND_ID),
			title: typeof title === 'string' ? title : title?.value,
			paletteEntries: MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(item => isIMenuItem(item) && item.command.id === NYALA_HELLO_COMMAND_ID).length,
			containerLocation: container && viewContainers.getViewContainerLocation(container),
			sidebarContainers: viewContainers.getViewContainers(ViewContainerLocation.Sidebar).filter(c => c.id === NYALA_CONNECTIONS_CONTAINER_ID).length,
			views: container && views.getViews(container).map(view => view.id),
			viewContainer: views.getViewContainer(NYALA_CONNECTIONS_VIEW_ID)?.id,
		}, {
			command: true,
			title: 'Nyala: Hello Workbench',
			paletteEntries: 1,
			containerLocation: ViewContainerLocation.Sidebar,
			sidebarContainers: 1,
			views: [NYALA_CONNECTIONS_VIEW_ID],
			viewContainer: NYALA_CONNECTIONS_CONTAINER_ID,
		});
	});

	test('a second registration of the same command, container or view cannot duplicate them', () => {
		const viewContainers = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		const views = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		const container = viewContainers.get(NYALA_CONNECTIONS_CONTAINER_ID)!;
		const view = views.getView(NYALA_CONNECTIONS_VIEW_ID)!;

		assert.throws(() => registerAction2(class extends Action2 {
			constructor() { super({ id: NYALA_HELLO_COMMAND_ID, title: { value: 'Duplicate', original: 'Duplicate' }, f1: true }); }
			override run(): void { }
		}), /Cannot register two commands with the same id: nyala\.hello/);
		assert.strictEqual(viewContainers.registerViewContainer({ ...container }, ViewContainerLocation.Sidebar), container);
		assert.throws(() => views.registerViews([{ ...view }], container), /already registered/);

		assert.deepStrictEqual({
			paletteEntries: MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(item => isIMenuItem(item) && item.command.id === NYALA_HELLO_COMMAND_ID).length,
			sidebarContainers: viewContainers.getViewContainers(ViewContainerLocation.Sidebar).filter(c => c.id === NYALA_CONNECTIONS_CONTAINER_ID).length,
			views: views.getViews(container).map(view => view.id),
		}, { paletteEntries: 1, sidebarContainers: 1, views: [NYALA_CONNECTIONS_VIEW_ID] });
	});

	test('running Nyala: Hello Workbench repeatedly shows the ready notification each time', () => {
		const messages: NotificationMessage[] = [];
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(INotificationService, new class extends TestNotificationService {
			override info(message: NotificationMessage) {
				messages.push(message);
				return super.info(message);
			}
		}());
		const handler = CommandsRegistry.getCommand(NYALA_HELLO_COMMAND_ID)!.handler;

		instantiationService.invokeFunction(accessor => handler(accessor));
		instantiationService.invokeFunction(accessor => handler(accessor));

		assert.deepStrictEqual(messages, [READY_MESSAGE, READY_MESSAGE]);
	});

	test('status entry is added once after restore and re-registration does not add another', async () => {
		const statusbar = createStatusbar();
		const { registry } = await openWindow(statusbar);

		registerContribution(registry);

		assert.ok(registry.getWorkbenchContribution(NyalaStatusContribution.ID) instanceof NyalaStatusContribution);
		assert.deepStrictEqual(statusbar.snapshot(), { added: 1, disposed: 0, live: [NYALA_STATUS_ENTRY] });
	});

	test('Reload Window disposes the status entry and the reloaded window recreates exactly one', async () => {
		const statusbar = createStatusbar();
		const states: ReturnType<typeof statusbar.snapshot>[] = [];

		const first = await openWindow(statusbar);
		states.push(statusbar.snapshot());

		first.lifecycle.reload();
		states.push(statusbar.snapshot());

		const second = await openWindow(statusbar);
		states.push(statusbar.snapshot());

		second.lifecycle.reload();
		states.push(statusbar.snapshot());

		assert.deepStrictEqual(states, [
			{ added: 1, disposed: 0, live: [NYALA_STATUS_ENTRY] },
			{ added: 1, disposed: 1, live: [] },
			{ added: 2, disposed: 1, live: [NYALA_STATUS_ENTRY] },
			{ added: 2, disposed: 2, live: [] },
		]);
	});

	test('disposing the status contribution twice releases its entry once', () => {
		const statusbar = createStatusbar();
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IStatusbarService, statusbar.service);

		const contribution = instantiationService.createInstance(NyalaStatusContribution);
		contribution.dispose();
		contribution.dispose();

		assert.deepStrictEqual(statusbar.snapshot(), { added: 1, disposed: 1, live: [] });
	});

	//#region Add-connection command

	test('registers the add-connection command and the add flow only accepts local files', async () => {
		const connections = new FakeConnectionService();
		const instantiationService = createWindowServices(connections);
		const messages: NotificationMessage[] = [];
		instantiationService.stub(INotificationService, new class extends TestNotificationService {
			override warn(message: NotificationMessage) { messages.push(message); return super.warn(message); }
		}());

		assert.ok(CommandsRegistry.getCommand(NYALA_ADD_SQLITE_CONNECTION_COMMAND_ID), 'the palette entry exists');

		await instantiationService.invokeFunction(accessor => addProfileForUri(accessor.get(INyalaConnectionService), accessor.get(INotificationService), URI.parse('https://example.com/demo.sqlite')));
		assert.deepStrictEqual({ calls: connections.calls, warned: messages.length }, { calls: [], warned: 1 }, 'a remote URI is refused before a profile exists');

		await instantiationService.invokeFunction(accessor => addProfileForUri(accessor.get(INyalaConnectionService), accessor.get(INotificationService), URI.file('/tmp/demo.sqlite')));
		assert.deepStrictEqual(connections.calls, ['addProfile', 'connect:p_1'], 'a local file becomes one profile and one connect');
	});

	//#endregion

	//#region Connections tree rows

	/** Builds the tree model over a fake service, exactly as the view does. */
	function createDataSource(connections: FakeConnectionService): NyalaConnectionsDataSource {
		const dataSource = new NyalaConnectionsDataSource();
		dataSource.attach(connections);
		return dataSource;
	}

	function labels(rows: readonly INyalaConnectionNode[]): { label: string; description?: string }[] {
		return rows.map(({ label, description }) => ({ label, description }));
	}

	test('one Profile row per connection, and a profile without a session shows what to do next', async () => {
		const connections = new FakeConnectionService();
		connections.rows = [profileState('disconnected')];
		const dataSource = createDataSource(connections);

		const [profile] = await dataSource.getChildren(connections);
		assert.deepStrictEqual(labels([profile]), [{ label: 'demo.sqlite', description: '/tmp/demo.sqlite' }]);
		assert.deepStrictEqual(labels(await dataSource.getChildren(profile)), [{ label: 'Not connected', description: '/tmp/demo.sqlite' }]);
	});

	test('a connected profile expands into Tables, Views and Indexes and lists its catalog', async () => {
		const connections = new FakeConnectionService();
		connections.rows = [profileState('connected', { handle: HANDLE })];
		connections.catalogs.set('p_1', { tables: ['customers'], views: ['recent_orders'], indexes: ['customers_by_name'] });
		const dataSource = createDataSource(connections);

		const [profile] = await dataSource.getChildren(connections);
		assert.deepStrictEqual(labels(await dataSource.getChildren(profile)), [
			{ label: 'Tables', description: undefined },
			{ label: 'Views', description: undefined },
			{ label: 'Indexes', description: undefined },
		]);

		const [tables] = await dataSource.getChildren(profile);
		const [customers] = await dataSource.getChildren(tables);
		assert.deepStrictEqual(labels([customers]), [{ label: 'customers', description: undefined }]);
		assert.deepStrictEqual(labels(await dataSource.getChildren(customers)), [{ label: 'id', description: 'INTEGER, primary key' }]);
		assert.deepStrictEqual(connections.calls, ['describe:customers'], 'columns are fetched through the service, once');
	});

	test('a connection that is still opening shows its progress instead of a usable session', async () => {
		const connections = new FakeConnectionService();
		connections.rows = [profileState('connecting')];
		const dataSource = createDataSource(connections);
		const [profile] = await dataSource.getChildren(connections);

		assert.deepStrictEqual(labels(await dataSource.getChildren(profile)), [{ label: 'Connecting...', description: '/tmp/demo.sqlite' }]);
	});

	test('a failed connection shows the runtime\'s safe detail, never [object Object]', async () => {
		const connections = new FakeConnectionService();
		connections.rows = [profileState('error', {
			error: { code: -32602, message: 'Invalid database', data: { kind: 'INVALID_PARAMS', retryable: false, safeDetail: 'file is not a SQLite database' } },
		})];
		const dataSource = createDataSource(connections);
		const [profile] = await dataSource.getChildren(connections);

		assert.deepStrictEqual(labels(await dataSource.getChildren(profile)), [{ label: 'Connection failed', description: 'file is not a SQLite database' }]);
	});

	test('a connection the runtime restart voided is shown as lost, not as connected', async () => {
		const connections = new FakeConnectionService();
		connections.rows = [profileState('lost', { error: { message: 'The runtime restarted. Reconnect to continue.' } })];
		const dataSource = createDataSource(connections);
		const [profile] = await dataSource.getChildren(connections);

		assert.deepStrictEqual(labels(await dataSource.getChildren(profile)), [{ label: 'Connection lost', description: 'The runtime restarted. Reconnect to continue.' }]);
	});

	test('a describe failure becomes a visible row instead of a broken twistie', async () => {
		const connections = new FakeConnectionService();
		connections.rows = [profileState('connected', { handle: HANDLE })];
		connections.catalogs.set('p_1', { tables: ['customers'], views: [], indexes: [] });
		connections.describeFailure = 'the runtime restarted; this connection must be opened again.';
		const dataSource = createDataSource(connections);

		const [profile] = await dataSource.getChildren(connections);
		const [tables] = await dataSource.getChildren(profile);
		const [customers] = await dataSource.getChildren(tables);
		const expected = [{ label: 'Could not load columns', description: 'the runtime restarted; this connection must be opened again.' }];

		assert.deepStrictEqual(labels(await dataSource.getChildren(customers)), expected);
		// The failure is remembered, so a re-expansion does not keep asking a runtime that went away.
		assert.deepStrictEqual(labels(await dataSource.getChildren(customers)), expected);
		assert.deepStrictEqual(connections.calls, ['describe:customers']);
	});

	//#endregion

	//#region Connections view

	test('the Connections view is wired through DI, asks the runtime where it is and shows the empty state', async () => {
		const connections = new FakeConnectionService();
		const { container } = renderConnectionsView(createWindowServices(connections));
		await whenRows(container, 0);

		assert.deepStrictEqual(connections.calls, ['refreshRuntime'], 'the first paint asks for the runtime state');
		const empty = container.querySelector('.nyala-connections-empty');
		assert.strictEqual(empty?.textContent, EMPTY_VIEW_MESSAGE);
		assert.strictEqual((empty as HTMLElement).style.display, '', 'the empty state is visible when there are no profiles');
	});

	test('a profile becomes a row and hides the empty state as soon as the service reports it', async () => {
		const connections = new FakeConnectionService();
		const { container } = renderConnectionsView(createWindowServices(connections));
		await whenRows(container, 0);

		connections.setRows([profileState('disconnected')]);
		await whenRows(container, 1);

		assert.deepStrictEqual(renderedRows(container), [{ name: 'demo.sqlite', description: '/tmp/demo.sqlite' }]);
		assert.strictEqual((container.querySelector('.nyala-connections-empty') as HTMLElement).style.display, 'none', 'the empty state hides once a profile exists');
	});

	test('opening a profile row connects it, and opening a connected profile disconnects it', async () => {
		const connections = new FakeConnectionService();
		connections.rows = [profileState('disconnected')];
		const { view, container } = renderConnectionsView(createWindowServices(connections));
		await whenRows(container, 1);
		const profileRow: INyalaConnectionNode = { kind: NyalaConnectionNodeKind.Profile, id: 'p_1', label: 'demo.sqlite', profileId: 'p_1' };

		await view.onDidOpenForTest(profileRow);
		assert.deepStrictEqual(connections.calls, ['refreshRuntime', 'connect:p_1']);

		connections.rows = [profileState('connected', { handle: HANDLE })];
		await view.onDidOpenForTest(profileRow);
		assert.deepStrictEqual(connections.calls, ['refreshRuntime', 'connect:p_1', 'disconnect:p_1']);
	});

	test('disposing the view stops it listening to the connection service', async () => {
		const connections = new FakeConnectionService();
		const { view, container } = renderConnectionsView(createWindowServices(connections));
		await whenRows(container, 0);
		const empty = container.querySelector('.nyala-connections-empty') as HTMLElement;

		view.dispose();
		connections.setRows([profileState('disconnected')]);
		await new Promise(resolve => setTimeout(resolve, 20));

		assert.strictEqual(empty.style.display, '', 'a change after dispose does not reach the disposed view');
	});

	test('reloading the window disposes the tree and the next window builds a fresh one', async () => {
		const connections = new FakeConnectionService();
		connections.rows = [profileState('disconnected')];
		const lifecycle = store.add(new TestReloadLifecycleService());
		const instantiationService = createWindowServices(connections, service => service.stub(ILifecycleService, lifecycle));

		const first = renderConnectionsView(instantiationService);
		await whenRows(first.container, 1);
		const callsBefore = connections.calls.length;

		lifecycle.reload();
		first.view.dispose();

		const second = renderConnectionsView(instantiationService);
		await whenRows(second.container, 1);

		assert.deepStrictEqual({
			firstRowsAfterDispose: renderedRows(first.container),
			secondRows: renderedRows(second.container),
			askedAgain: connections.calls.slice(callsBefore),
		}, {
			firstRowsAfterDispose: [],
			secondRows: [{ name: 'demo.sqlite', description: '/tmp/demo.sqlite' }],
			askedAgain: ['refreshRuntime'],
		}, 'the reloaded window rebuilds the tree and asks for the runtime state again');
	});

	//#endregion
});
