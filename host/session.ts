import { Client } from "./client";
import { escape } from "./event-loop";
import { HostSandbox, HostSandboxOptions, LocalSessionSandbox, RenderOptions, SessionSandbox, SessionSandboxClient } from "./session-sandbox";

import { JsonValue } from "mobius-types";
import { Event, eventForException, eventForValue, parseValueEvent, roundTrip } from "../common/_internal";

import { ChildProcess, fork } from "child_process";
import { Request } from "express";

function generateBaseURL(options: HostSandboxOptions, request?: Request) {
	if (request) {
		return request.protocol + "://" + (options.hostname || request.get("host")) + request.url.replace(/(\.websocket)?\?.*$/, "");
	}
	throw new Error("Session does not have a request to load URL from!");
}

export interface ClientCoordinator {
	newClient(session: Session, request: Request): Client;
	getClient(clientID: number): Client | undefined;
	deleteClient(clientID: number): void;
}

export interface Session extends SessionSandbox {
	lastMessageTime: number;
	readonly sessionID: string;
	readonly client: ClientCoordinator;
}

// Actual client implementation that allows enqueuing/dequeueing events from multiple clients
class InProcessClients implements SessionSandboxClient, ClientCoordinator {
	private clients = new Map<number, Client>();
	private currentClientID: number = 0;
	public sharingEnabled: boolean = false;
	public session?: Session;
	constructor(private sessionWithIdWasDestroyed: (sessionId: string) => void, private request?: Request) {
	}
	public async synchronizeChannels(): Promise<void> {
		const promises: Array<Promise<void>> = [];
		for (const client of this.clients.values()) {
			promises.push(client.synchronizeChannels());
		}
		await Promise.all(promises);
	}
	public scheduleSynchronize() {
		for (const client of this.clients.values()) {
			client.scheduleSynchronize();
		}
	}
	public async sessionWasDestroyed() {
		const promises: Array<Promise<void>> = [];
		for (const client of this.clients.values()) {
			promises.push(client.destroy());
		}
		await Promise.all(promises);
		this.sessionWithIdWasDestroyed(this.session!.sessionID);
	}
	public sendEvent(event: Event) {
		for (const client of this.clients.values()) {
			client.sendEvent(event);
		}
	}
	public setCookie(key: string, value: string) {
		for (const client of this.clients.values()) {
			client.setCookie(key, value);
		}
	}
	public cookieHeader() {
		if (this.request) {
			const cookieHeader = this.request.headers.cookie;
			if (cookieHeader) {
				return cookieHeader.toString();
			}
		}
		return "";
	}
	public getBaseURL(options: HostSandboxOptions) {
		return generateBaseURL(options, this.request);
	}
	public sharingBecameEnabled() {
		this.sharingEnabled = true;
	}
	public getClientIds() {
		return Array.from(this.clients.keys());
	}
	public newClient(session: Session, request: Request) {
		const newClientId = this.currentClientID++;
		if ((newClientId == 0) || this.sharingEnabled) {
			const result = new Client(session, request, newClientId);
			this.clients.set(newClientId, result);
			this.session!.sendPeerCallback(newClientId, true);
			return result;
		}
		throw new Error("Multiple clients attached to the same session are not supported!");
	}
	public getClient(clientID: number): Client | undefined {
		return this.clients.get(clientID);
	}
	public deleteClient(clientID: number): boolean {
		if (this.clients.has(clientID)) {
			this.clients.delete(clientID);
			this.session!.sendPeerCallback(clientID, false);
		}
		return this.clients.size === 0;
	}
}

class InProcessSession extends LocalSessionSandbox<InProcessClients> implements Session {
	public lastMessageTime: number = Date.now();
}

let toWorkerMessageId = 0;
let toHostMessageId = 0;
const workerResolves = new Map<number, [(value: any) => void, (value: any) => void]>();

type CommandMessage = [string, string, number];

// Send messages from worker process to parent
class WorkerSandboxClient implements SessionSandboxClient {
	public sessionID: string;
	constructor(sessionID: string) {
		this.sessionID = sessionID;
	}
	public send<T = void>(method: string, args?: any[]): Promise<T> {
		const responseId = toHostMessageId = (toHostMessageId + 1) | 0;
		const prefix: CommandMessage = [this.sessionID, method, responseId];
		process.send!(args ? prefix.concat(args) : prefix);
		return new Promise<T>((resolve, reject) => {
			workerResolves.set(responseId, [resolve, reject]);
		});
	}
	public sendOneWay(method: string, args?: any[]) {
		const prefix: CommandMessage = [this.sessionID, method, 0];
		process.send!(args ? prefix.concat(args) : prefix);
	}
	public scheduleSynchronize() {
		return this.sendOneWay("scheduleSynchronize");
	}
	public sessionWasDestroyed() {
		return this.sendOneWay("sessionWasDestroyed");
	}
	public sendEvent(event: Event) {
		return this.send("sendEvent", [event]);
	}
	public setCookie(key: string, value: string) {
		return this.sendOneWay("setCookie", [key, value]);
	}
	public cookieHeader() {
		return this.send<string>("cookieHeader");
	}
	public getBaseURL(options: HostSandboxOptions) {
		return this.send<string>("getBaseURL", [options]);
	}
	public sharingBecameEnabled() {
		return this.sendOneWay("sharingBecameEnabled");
	}
	public getClientIds() {
		return this.send<number[]>("getClientIds");
	}
}

// Send messages from parent process to worker
class OutOfProcessSession implements Session {
	public lastMessageTime: number = Date.now();
	constructor(public readonly client: InProcessClients, public readonly sessionID: string, private readonly process: ChildProcess) {
	}
	public send<T = void>(method: string, args?: any[]): Promise<T> {
		const responseId = toWorkerMessageId = (toWorkerMessageId + 1) | 0;
		const prefix: CommandMessage = [this.sessionID, method, responseId];
		this.process.send(args ? prefix.concat(args) : prefix);
		return new Promise<T>((resolve, reject) => {
			workerResolves.set(responseId, [resolve, reject]);
		});
	}
	public sendOneWay(method: string, args?: any[]) {
		const prefix: CommandMessage = [this.sessionID, method, 0];
		this.process.send!(args ? prefix.concat(args) : prefix);
	}
	public destroy(): Promise<void> {
		return this.send("destroy");
	}
	public destroyIfExhausted(): Promise<void> {
		return this.send("destroyIfExhausted");
	}
	public archiveEvents(includeTrailer: boolean): Promise<void> {
		return this.send("archiveEvents", [includeTrailer]);
	}
	public unarchiveEvents() {
		return this.send("unarchiveEvents");
	}
	public processEvents(events: Event[], noJavaScript?: boolean) {
		return this.send("processEvents", [events, noJavaScript]);
	}
	public prerenderContent() {
		return this.send("prerenderContent");
	}
	public updateOpenServerChannelStatus(newValue: boolean) {
		return this.sendOneWay("updateOpenServerChannelStatus", [newValue]);
	}
	public hasLocalChannels() {
		return this.send<boolean>("hasLocalChannels");
	}
	public render(options: RenderOptions): Promise<string> {
		return this.send<string>("render", [options]);
	}
	public valueForFormField(name: string): Promise<string | undefined> {
		return this.send<string | undefined>("valueForFormField", [name]);
	}
	public becameActive() {
		return this.sendOneWay("becameActive");
	}
	public sendPeerCallback(clientId: number, joined: boolean) {
		// Don't bother sending peer callbacks to child processes
		if (this.client.sharingEnabled) {
			return this.sendOneWay("sendPeerCallback", [clientId, joined]);
		}
	}
}

type BroadcastMessage = [false, string, JsonValue];

type FileReadMessage = [true, string];

function isCommandMessage(message: CommandMessage | Event | BroadcastMessage | FileReadMessage): message is CommandMessage {
	return typeof message[0] === "string";
}

function isEvent(message: CommandMessage | Event | BroadcastMessage | FileReadMessage): message is Event {
	return typeof message[0] === "number";
}

function isBroadcastMessage(message: CommandMessage | Event | BroadcastMessage | FileReadMessage): message is BroadcastMessage {
	return typeof message[0] === "boolean" && !message[0];
}

function constructBroadcastModule() {
	const topics = new Map<string, Set<(message: JsonValue) => void>>();
	return {
		send(topic: string, message: JsonValue) {
			const observers = topics.get(topic);
			if (observers) {
				for (const observer of observers.values()) {
					try {
						observer(roundTrip(message));
					} catch (e) {
						escape(e);
					}
				}
			}
		},
		addListener(topic: string, callback: (message: JsonValue) => void): void {
			let observers = topics.get(topic);
			if (!observers) {
				topics.set(topic, observers = new Set<(message: JsonValue) => void>());
			}
			observers.add(callback);
		},
		removeListener(topic: string, callback: (message: JsonValue) => void): void {
			const observers = topics.get(topic);
			if (observers && observers.delete(callback) && observers.size === 0) {
				topics.delete(topic);
			}
		},
	};
}

if (require.main === module) {
	// Handle messages from parent inside worker
	process.addListener("message", function bootstrap(options: HostSandboxOptions) {
		const basicBroadcast = constructBroadcastModule();
		const host = new HostSandbox(options, (path: string) => {
			const fileReadMessage: FileReadMessage = [true, path];
			process.send!(fileReadMessage);
		}, {
			send(topic: string, message: JsonValue) {
				const broadcastMessage: BroadcastMessage = [false, topic, message];
				process.send!(broadcastMessage);
				basicBroadcast.send(topic, message);
			},
			addListener: basicBroadcast.addListener,
			removeListener: basicBroadcast.removeListener,
		});
		const sessions = new Map<string, LocalSessionSandbox<WorkerSandboxClient>>();
		process.removeListener("message", bootstrap);
		process.addListener("message", async (message: CommandMessage | Event | BroadcastMessage) => {
			if (isCommandMessage(message)) {
				// Dispatch commands from master
				const sessionID = message[0];
				let session: any = sessions.get(sessionID);
				if (!session) {
					sessions.set(sessionID, session = new LocalSessionSandbox<WorkerSandboxClient>(host, new WorkerSandboxClient(sessionID), sessionID));
				}
				try {
					const result = (session as { [method: string]: () => Promise<any> })[message[1]].apply(session, message.slice(3));
					if (message[2]) {
						process.send!(eventForValue(message[2], await result));
					}
				} catch (e) {
					if (message[2]) {
						process.send!(eventForException(message[2], e));
					} else {
						escape(e);
					}
				}
			} else if (isEvent(message)) {
				// Handle promise response
				const resolve = workerResolves.get(message[0]);
				if (resolve) {
					workerResolves.delete(message[0]);
					parseValueEvent(global, message, resolve[0], resolve[1]);
				}
			} else if (isBroadcastMessage(message)) {
				// Receive broadcast from another worker
				basicBroadcast.send(message[1], message[2]);
			}
		});
	});
}

export interface SessionGroup {
	constructSession(sessionID: string, request?: Request): Session;
	getSessionById(sessionID: string): Session | undefined;
	allSessions(): IterableIterator<Session>;
	destroy(): Promise<void>;
}

let currentDebugPort = (process as any).debugPort as number;

export function createSessionGroup(options: HostSandboxOptions, fileRead: (path: string) => void, workerCount: number): SessionGroup {
	if (workerCount <= 0) {
		// Dispatch messages in-process instead of creating workers
		const host = new HostSandbox(options, fileRead, constructBroadcastModule());
		const sessions = new Map<string, InProcessSession>();
		const destroySessionById = sessions.delete.bind(sessions);
		return {
			constructSession(sessionID: string, request?: Request) {
				const client = new InProcessClients(destroySessionById, request);
				const result = new InProcessSession(host, client, sessionID);
				client.session = result;
				sessions.set(sessionID, result);
				return result;
			},
			getSessionById(sessionID: string) {
				return sessions.get(sessionID);
			},
			allSessions() {
				return sessions.values();
			},
			async destroy() {
			},
		};
	}
	const sessions = new Map<string, OutOfProcessSession>();
	const workers: ChildProcess[] = [];
	let lastProcessExited: () => void;
	const exitedPromise = new Promise<void>(resolve => lastProcessExited = resolve);
	let exitedCount = 0;
	for (let i = 0; i < workerCount; i++) {
		// Fork a worker to run sessions with node debug command line arguments rewritten
		const worker = workers[i] = fork(require.resolve("./session"), [], {
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
		worker.on("exit", () => {
			if ((++exitedCount) === workerCount) {
				lastProcessExited!();
			}
		});
		worker.send(options);
		worker.addListener("message", async (message: CommandMessage | Event | BroadcastMessage | FileReadMessage) => {
			if (isCommandMessage(message)) {
				// Dispatch commands from worker
				const sessionID = message[0];
				const session = sessions.get(sessionID);
				if (session) {
					const client: any = session.client;
					try {
						const result = ((client as { [method: string]: () => Promise<any> })[message[1]].apply(client, message.slice(3)));
						if (message[2]) {
							worker.send(eventForValue(message[2], await result));
						}
					} catch (e) {
						if (message[2]) {
							worker.send(eventForException(message[2], e));
						} else {
							escape(e);
						}
					}
				} else if (message[2]) {
					worker.send([message[2]]);
				}
			} else if (isEvent(message)) {
				// Handle promise responses
				const resolve = workerResolves.get(message[0]);
				if (resolve) {
					workerResolves.delete(message[0]);
					parseValueEvent(global, message, resolve[0], resolve[1]);
				}
			} else if (isBroadcastMessage(message)) {
				// Forward broadcast message to other workers
				for (const otherWorker of workers) {
					if (otherWorker !== worker) {
						otherWorker.send(message);
					}
				}
			} else {
				fileRead(message[1]);
			}
		});
	}
	let currentWorker = 0;
	const destroySessionById = sessions.delete.bind(sessions);
	return {
		constructSession(sessionID: string, request?: Request) {
			const client = new InProcessClients(destroySessionById, request);
			const result = new OutOfProcessSession(client, sessionID, workers[currentWorker]);
			client.session = result;
			// Rotate through workers
			if ((++currentWorker) === workerCount) {
				currentWorker = 0;
			}
			sessions.set(sessionID, result);
			return result;
		},
		getSessionById(sessionID: string) {
			return sessions.get(sessionID);
		},
		allSessions() {
			return sessions.values();
		},
		destroy() {
			for (const worker of workers) {
				// TODO: Ask them to cleanup gracefully
				worker.kill();
			}
			return exitedPromise;
		},
	};
}
