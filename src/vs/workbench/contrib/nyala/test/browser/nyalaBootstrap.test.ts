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
import { NYALA_HELLO_COMMAND_ID, NyalaStatusContribution } from '../../bootstrap/browser/nyala.contribution.js';
import { NYALA_CONNECTIONS_VIEW_ID, NyalaConnectionsView } from '../../bootstrap/browser/nyalaConnectionsView.js';

const NYALA_CONNECTIONS_CONTAINER_ID = 'nyala.connections.container';

/** Registers into one registry with the service-typed signature the module-level helper uses. */
function registerContribution(registry: WorkbenchContributionsRegistry): void {
	const register = registry.registerWorkbenchContribution2.bind(registry) as typeof registerWorkbenchContribution2;
	register(NyalaStatusContribution.ID, NyalaStatusContribution, WorkbenchPhase.AfterRestored);
}
const READY_MESSAGE = 'Nyala Studio Workbench is ready.';
const PLACEHOLDER = 'Nyala connections will appear here.';

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

	function renderConnectionsView(instantiationService: ITestInstantiationService) {
		const container = append(mainWindow.document.body, $('.pane-body'));
		store.add(toDisposable(() => container.remove()));
		const view = instantiationService.createInstance(TestNyalaConnectionsView, { id: NYALA_CONNECTIONS_VIEW_ID, title: 'Connections' });
		view.renderBodyForTest(container);
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

	test('Connections view renders one placeholder per window and is re-created after a reload', () => {
		const lifecycle = store.add(new TestReloadLifecycleService());
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(ILifecycleService, lifecycle);
		instantiationService.stub(IViewDescriptorService, new class extends mock<IViewDescriptorService>() {
			override readonly onDidChangeLocation = Event.None;
			override getViewLocationById() { return ViewContainerLocation.Sidebar; }
		}());

		const first = renderConnectionsView(instantiationService);
		lifecycle.reload();
		first.view.dispose();

		const second = renderConnectionsView(instantiationService);
		store.add(second.view);

		const placeholders = (container: HTMLElement) => [...container.querySelectorAll('.nyala-connections-placeholder')].map(element => element.textContent);
		assert.deepStrictEqual({
			first: placeholders(first.container),
			second: placeholders(second.container),
		}, {
			first: [PLACEHOLDER],
			second: [PLACEHOLDER],
		});
	});
});
