import { Client } from "./client";
import { ClientState, PageRenderMode } from "./page-renderer";
import { ClientBootstrap, HostSandbox, HostSandboxOptions, LocalSessionSandbox, SessionSandbox, SessionSandboxClient } from "./session-sandbox";

import { eventForException, eventForValue, parseValueEvent, Event } from "../common/_internal";

import { fork, ChildProcess } from "child_process";
import { Request } from "express";

function generateBaseURL(options: HostSandboxOptions, request?: Request) {
	if (request) {
		return request.protocol + "://" + (options.hostname || request.get("host")) + request.url.replace(/(\.websocket)?\?.*$/, "");
	}
	throw new Error("Session does not have a request to load URL from!");
}

export interface Session extends SessionSandbox {
	lastMessageTime: number;
	client: SessionClients;
}

export interface SessionClients extends SessionSandboxClient {
	clients: Map<number, Client>;
	newClient(session: Session, request: Request) : Client;
	get(clientID: number) : Client | undefined;
}

class InProcessClients implements SessionClients {
	sessionID: string;
	sessions: Map<string, Session>;
	request?: Request;
	clients = new Map<number, Client>();
	currentClientID: number = 0;
	sharingEnabled: boolean = false;
	lastMessageTime: number = Date.now();
	constructor(sessionID: string, sessions: Map<string, Session>, request?: Request) {
		this.sessionID = sessionID;
		this.sessions = sessions;
		this.request = request;
	}
	async synchronizeChannels() : Promise<void> {
		const promises : Promise<void>[] = [];
		for (let client of this.clients.values()) {
			promises.push(client.synchronizeChannels());
		}
		await Promise.all(promises);
	}
	async scheduleSynchronize() {
		for (const client of this.clients.values()) {
			client.scheduleSynchronize();
		}
	}
	async sessionWasDestroyed() {
		const promises : Promise<void>[] = [];
		for (const client of this.clients.values()) {
			promises.push(client.destroy());
		}
		await Promise.all(promises);
		this.sessions.delete(this.sessionID);
	}
	async sendEvent(event: Event) {
		for (const client of this.clients.values()) {
			client.sendEvent(event);
		}
	}
	async setCookie(key: string, value: string) {
		for (const client of this.clients.values()) {
			client.setCookie(key, value);
		}
	}
	async getBaseURL(options: HostSandboxOptions) {
		return generateBaseURL(options, this.request);
	}
	newClient(session: Session, request: Request) {
		const newClientId = this.currentClientID++;
		if ((newClientId == 0) || this.sharingEnabled) {
			const result = new Client(session, request, newClientId);
			this.clients.set(newClientId, result);
			return result;
		}
		throw new Error("Multiple clients attached to the same session are not supported!");
	}
	get(clientID: number) : Client | undefined {
		return this.clients.get(clientID);
	}
}

class InProcessSession extends LocalSessionSandbox<InProcessClients> implements Session {
	lastMessageTime: number = Date.now();
}


let toWorkerMessageId = 0;
let toHostMessageId = 0;
const workerResolves = new Map<number, [(value: any) => void, (value: any) => void]>();

type CommandMessage = [string, string, number];

class WorkerSandboxClient implements SessionSandboxClient {
	sessionID: string;
	constructor(sessionID: string) {
		this.sessionID = sessionID;
	}
	send<T = void>(method: string, args?: any[]) : Promise<T> {
		const responseId = toHostMessageId = (toHostMessageId + 1) | 0;
		const prefix: CommandMessage = [this.sessionID, method, responseId];
		process.send!(args && args.length ? prefix.concat(args) : prefix);
		return new Promise<T>((resolve, reject) => {
			workerResolves.set(responseId, [resolve, reject]);
		});
	}
	synchronizeChannels() : Promise<void> {
		return this.send("synchronizeChannels");
	}
	scheduleSynchronize() {
		return this.send("scheduleSynchronize");
	}
	sessionWasDestroyed() {
		return this.send("sessionWasDestroyed");
	}
	sendEvent(event: Event) {
		return this.send("sendEvent", [event]);
	}
	setCookie(key: string, value: string) {
		return this.send("setCookie", [key, value]);
	}
	getBaseURL(options: HostSandboxOptions) {
		return this.send<string>("getBaseURL", [options]);
	}
}

class OutOfProcessSession implements Session {
	sessionID: string;
	process: ChildProcess;
	client: InProcessClients;
	lastMessageTime: number = Date.now();
	constructor(client: InProcessClients, sessionID: string, process: ChildProcess) {
		this.client = client;
		this.sessionID = sessionID;
		this.process = process;
	}
	send<T = void>(method: string, args?: any[]) : Promise<T> {
		const responseId = toWorkerMessageId = (toWorkerMessageId + 1) | 0;
		const prefix: CommandMessage = [this.sessionID, method, responseId];
		this.process.send(args && args.length ? prefix.concat(args) : prefix);
		return new Promise<T>((resolve, reject) => {
			workerResolves.set(responseId, [resolve, reject]);
		});
	}
	destroy() : Promise<void> {
		return this.send("destroy");
	}
	destroyIfExhausted() : Promise<void> {
		return this.send("destroyIfExhausted");
	}
	archiveEvents(includeTrailer: boolean) : Promise<void> {
		return this.send("archiveEvents", [includeTrailer]);
	}
	unarchiveEvents() {
		return this.send("unarchiveEvents");
	}
	processEvents(events: Event[], noJavaScript?: boolean) {
		return this.send("processEvents", [events, noJavaScript]);
	}
	prerenderContent() {
		return this.send("prerenderContent");
	}
	updateOpenServerChannelStatus(newValue: boolean) {
		return this.send("updateOpenServerChannelStatus", [newValue]);
	}
	hasLocalChannels() {
		return this.send<boolean>("hasLocalChannels");
	}
	render(mode: PageRenderMode, client: ClientState & ClientBootstrap, clientURL: string, noScriptURL?: string, bootstrap?: boolean) : Promise<string> {
		return this.send<string>("render", [mode, client, clientURL, noScriptURL, bootstrap]);
	}
	valueForFormField(name: string) : Promise<string | undefined> {
		return this.send<string | undefined>("valueForFormField", [name]);
	}
	becameActive() {
		return this.send("becameActive");
	}
}

function isCommandMessage(message: CommandMessage | Event) : message is CommandMessage {
	return typeof message[0] === "string";
}

if (require.main === module) {
	process.addListener("message", function bootstrap(options: HostSandboxOptions) {
		const host = new HostSandbox(options);
		const sessions = new Map<string, LocalSessionSandbox<WorkerSandboxClient>>();
		process.removeListener("message", bootstrap);
		process.addListener("message", async (message: CommandMessage | Event) => {
			if (isCommandMessage(message)) {
				const sessionID = message[0];
				let session: any = sessions.get(sessionID);
				if (!session) {
					sessions.set(sessionID, session = new LocalSessionSandbox<WorkerSandboxClient>(host, new WorkerSandboxClient(sessionID), sessionID));
				}
				try {
					const result = await (session as { [method: string] : () => Promise<any> })[message[1]].apply(session, message.slice(3));
					process.send!(eventForValue(message[2], result));
				} catch (e) {
					process.send!(eventForException(message[2], e));
				}
			} else {
				const resolve = workerResolves.get(message[0]);
				if (resolve) {
					workerResolves.delete(message[0]);
					parseValueEvent(global, message, resolve[0], resolve[1]);
				}
			}
		});
	});
}

export function createSessionGroup(options: HostSandboxOptions, sessions: Map<string, Session>, workerCount: number) {
	if (workerCount <= 0) {
		const host = new HostSandbox(options);
		return (sessionID: string, request?: Request) => new InProcessSession(host, new InProcessClients(sessionID, sessions, request), sessionID);
	}
	const workers: ChildProcess[] = [];
	for (let i = 0; i < workerCount; i++) {
		const worker = workers[i] = fork(require.resolve("./session"), [], {
			env: process.env,
			cwd: process.cwd(),
			execArgv: process.execArgv.map(option => {
				const debugOption = option.match(/^(--inspect|--inspect-(brk|port)|--debug|--debug-(brk|port))(=\d+)?$/);
				if (!debugOption) {
					return option;
				}
				return debugOption[1] + "=" + (((process as any).debugPort as number) + i + 1);
			}),
			stdio: [0, 1, 2, "ipc"]
		});
		worker.send(options);
		worker.addListener("message", async (message: CommandMessage | Event) => {
			if (isCommandMessage(message)) {
				const sessionID = message[0];
				const session = sessions.get(sessionID);
				if (session) {
					const client: any = session.client;
					try {
						const result = await ((client as { [method: string] : () => Promise<any> })[message[1]].apply(client, message.slice(3)));
						worker.send(eventForValue(message[2], result));
					} catch (e) {
						worker.send(eventForException(message[2], e));
					}
				} else {
					worker.send([message[2]]);
				}
			} else {
				const resolve = workerResolves.get(message[0]);
				if (resolve) {
					workerResolves.delete(message[0]);
					parseValueEvent(global, message, resolve[0], resolve[1]);
				}
			}
		});
	}
	let currentWorker = 0;
	return (sessionID: string, request?: Request) => {
		const result = new OutOfProcessSession(new InProcessClients(sessionID, sessions, request), sessionID, workers[currentWorker]);
		if ((++currentWorker) === workerCount) {
			currentWorker = 0;
		}
		return result;
	}
}
