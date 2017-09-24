import { flush, createServerChannel } from "mobius";
import { JsonValue, Channel } from "mobius-types";
import { Redacted } from "redact";

export const send: (topic: string | Redacted<string>, message: JsonValue | Redacted<string>) => void = flush;
export function receive(topic: string | Redacted<string>, callback: (message: JsonValue) => void, onAbort?: () => void) : Channel {
	return createServerChannel(callback, onAbort);
}
