/// <reference types="preact" />

namespace concurrence {
	export function host(content: JSX.Element) : void {
		const document = (self as any).document as Document;
		const element = document.body;
		preact.render(content, element, element.children[0]);
	}
}
