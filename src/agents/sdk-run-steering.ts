import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession, ExtensionRunner, ResourceLoader } from "@earendil-works/pi-coding-agent";

interface OwnedSteer {
  loader: ResourceLoader;
  runner: ExtensionRunner;
  signal: AbortSignal;
  isOpen: () => boolean;
  checkedCommit: boolean;
}

const currentSteer = new AsyncLocalStorage<OwnedSteer>();
const guardedLoaders = new WeakSet<ResourceLoader>();
const guardedRunners = new WeakSet<ExtensionRunner>();

export class RunSteerClosed extends Error {
  constructor() {
    super("The owning run no longer accepts steering.");
  }
}

function checkOpen(steer: OwnedSteer): void {
  if (steer.signal.aborted || !steer.isOpen()) throw new RunSteerClosed();
}

export function guardSteeringCommit(loader: ResourceLoader): void {
  if (guardedLoaders.has(loader)) return;
  guardedLoaders.add(loader);
  const getPrompts = loader.getPrompts.bind(loader);
  loader.getPrompts = () => {
    const result = getPrompts();
    const steer = currentSteer.getStore();
    if (steer?.loader === loader && !steer.checkedCommit) {
      // SDK 1.0.3 reads templates synchronously after its last input await,
      // even with no templates. Expansion and both queue writes follow on
      // this stack. Guarding agent.steer would leave the display queue dirty.
      checkOpen(steer);
      steer.checkedCommit = true;
    }
    return result;
  };
}

function guardInputWait(runner: ExtensionRunner): void {
  if (guardedRunners.has(runner)) return;
  guardedRunners.add(runner);
  const emitInput = runner.emitInput.bind(runner);
  runner.emitInput = (...args) => {
    const steer = currentSteer.getStore();
    if (steer?.runner !== runner || steer.checkedCommit) return emitInput(...args);
    checkOpen(steer);
    const { signal } = steer;
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new RunSteerClosed());
      signal.addEventListener("abort", cancel, { once: true });
    });
    // Keep SDK transforms and handled short-circuiting. Extension code can
    // start its own work, so it must not inherit this submission's ownership.
    const input = currentSteer.exit(() => emitInput(...args));
    return Promise.race([input, cancelled]).finally(() => signal.removeEventListener("abort", cancel));
  };
}

type SteeringSession = Pick<AgentSession, "steer"> & Partial<Pick<AgentSession, "resourceLoader" | "extensionRunner">>;

export function steerForRun(
  session: SteeringSession,
  message: string,
  signal: AbortSignal,
  isOpen: () => boolean,
): ReturnType<AgentSession["steer"]> {
  const loader = session.resourceLoader;
  const runner = session.extensionRunner;
  if (!loader || !runner || !guardedLoaders.has(loader)) return session.steer(message);
  // reload() replaces the runner while keeping the session's resource loader.
  guardInputWait(runner);
  const steer = { loader, runner, signal, isOpen, checkedCommit: false };
  return currentSteer.run(steer, () => session.steer(message));
}
