import { fork } from "child_process";

let workerThreads: (typeof import ("worker_threads")) | undefined;
try {
	workerThreads = require("worker_threads");
} catch (e) {
	workerThreads = undefined;
}

export const supportsWorkerThreads: boolean = typeof workerThreads !== "undefined";

export interface Port {
	onmessage?: (message: any) => void;
	postMessage(message: any): void;
}

export const parent: Port | undefined = (() => {
	if (workerThreads) {
		const parentPort = workerThreads.parentPort;
		if (parentPort) {
			const result: Port = {
				postMessage: parentPort.postMessage.bind(parentPort),
			};
			parentPort.onmessage = (event) => {
				if (result.onmessage) {
					result.onmessage(event);
				}
			};
			return result;
		}
	}
	if (process.send) {
		const result: Port = {
			postMessage: process.send.bind(process),
		};
		process.addListener("message", (event) => {
			if (result.onmessage) {
				result.onmessage(event);
			}
		});
		return result;
	}
})();

export interface Worker extends Port {
	terminate(): Promise<void>;
}

let currentDebugPort = (process as any).debugPort as number;

export function createWorker(path: string, useWorkerThreads: boolean = true): Worker {
	if (useWorkerThreads && workerThreads) {
		const worker = new workerThreads.Worker(path);
		const result: Worker = {
			terminate() {
				return new Promise<void>((resolve) => {
					worker.terminate(resolve);
				});
			},
			postMessage: worker.postMessage.bind(worker),
		};
		worker.addListener("message", (event) => {
			if (result.onmessage) {
				result.onmessage(event);
			}
		});
		return result;
	} else {
		const child = fork(path, [], {
			env: process.env,
			cwd: process.cwd(),
			execArgv: process.execArgv.map((option) => {
				const debugOption = option.match(/^(--inspect|--inspect-(brk|port)|--debug|--debug-(brk|port))(=\d+)?$/);
				if (!debugOption) {
					return option;
				}
				return debugOption[1] + "=" + ++currentDebugPort;
			}),
			stdio: [0, 1, 2, "ipc"],
		});
		const result: Worker = {
			async terminate() {
				child.kill();
			},
			postMessage: child.send.bind(child),
		};
		child.addListener("message", (event) => {
			if (result.onmessage) {
				result.onmessage(event);
			}
		});
		return result;
	}
}
