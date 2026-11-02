/** Explicit owners for unit suites; real factory isolation uses instance-fixtures instead. */
import { vi } from "vite-plus/test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionOwner } from "../src/shell.js";
import { asExtensionOwner, asExtensionAPI } from "./pi-boundaries.js";
import { agentRegistryFixtureFactory } from "./agent-types-mock.js";

interface ShellFixtureModule {
  getStore?: () => unknown;
  getManager?: () => unknown;
  getWidget?: () => unknown;
  getCoordinator?: () => unknown;
  getSessionCtx?: () => unknown;
  getPiInstance?: () => unknown;
  [key: string]: unknown;
}

function copyFixture(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  return Object.create(Object.getPrototypeOf(value), Object.getOwnPropertyDescriptors(value));
}

export async function ownerShellMock(module: ShellFixtureModule) {
  const createRegistry = await agentRegistryFixtureFactory();
  const createExtensionOwner = (pi: ExtensionAPI): ExtensionOwner => {
    const registry = createRegistry();
    return asExtensionOwner({
      pi: module.getPiInstance?.() ?? pi,
      registry,
      rendererInvalidations: new Map<string, () => void>(),
      sessionCtx: copyFixture(module.getSessionCtx?.()) ?? null,
      store: copyFixture(module.getStore?.()) ?? null,
      manager: copyFixture(module.getManager?.()) ?? null,
      widget: copyFixture(module.getWidget?.()) ?? null,
      coordinator: copyFixture(module.getCoordinator?.()) ?? null,
      generation: 0,
      unregisterTerminalInput: null,
    });
  };
  return {
    ...module,
    isOwnerFixture: true,
    createExtensionOwner,
    getPiInstance: vi.fn((owner: ExtensionOwner) => owner.pi),
    getSessionCtx: vi.fn((owner: ExtensionOwner) => owner.sessionCtx),
    getStore: vi.fn((owner: ExtensionOwner) => {
      if (!owner.store) throw new Error("Test session store missing");
      return owner.store;
    }),
    getManager: vi.fn((owner: ExtensionOwner) => owner.manager),
    getWidget: vi.fn((owner: ExtensionOwner) => owner.widget),
    getCoordinator: vi.fn((owner: ExtensionOwner) => owner.coordinator),
    setSessionCtx: vi.fn((owner: ExtensionOwner, ctx: ExtensionOwner["sessionCtx"]) => {
      owner.sessionCtx = ctx;
    }),
    setManager: vi.fn((owner: ExtensionOwner, manager: ExtensionOwner["manager"]) => {
      owner.manager = manager;
    }),
    setWidget: vi.fn((owner: ExtensionOwner, widget: ExtensionOwner["widget"]) => {
      owner.widget = widget;
    }),
    setCoordinator: vi.fn((owner: ExtensionOwner, coordinator: ExtensionOwner["coordinator"]) => {
      owner.coordinator = coordinator;
    }),
  };
}

export async function createTestOwner(): Promise<ExtensionOwner> {
  const shell = await import("../src/shell.js");
  const factory = "isOwnerFixture" in shell ? shell : await ownerShellMock({});
  const owner = factory.createExtensionOwner(asExtensionAPI({ sendMessage: vi.fn(), exec: vi.fn() }));
  if (!owner.store) {
    const { ConfigStore } = await vi.importActual<typeof import("../src/config/config-store.js")>(
      "../src/config/config-store.js",
    );
    owner.store = new ConfigStore({
      load: () => ({ global: {}, project: null, projectStatus: "untrusted" }),
      updateLayer: () => ({ global: {}, project: null, projectStatus: "untrusted" }),
      saveGlobal: vi.fn(),
      saveProject: vi.fn(),
    });
  }
  return owner;
}
