import includePaths from "rollup-plugin-includepaths";
import rollupBabel from "rollup-plugin-babel";
import babel from "babel-core";
import { pureBabylon as pure } from "side-effects-safe";

const rewriteForInStatements = require("./rewriteForInStatements");

const types = babel.types;

function stripRedact() {
	return {
		visitor: {
			CallExpression(path) {
				if (path.get("callee").node.name == "redact" && path.node.arguments.length != 0) {
					if (path.node.arguments.every(node => pure(node, { pureMembers: /./ }))) {
						path.replaceWith(types.callExpression(types.identifier("redact"), []));
					} else {
						throw path.buildCodeFrameError(`Potential side-effects in ${path.getSource()}, where only pure arguments are expected!`);
					}
				}
			}
		}
	};
}

export default {
	entry: "src/app.js",
	dest: "public/client.js",
	format: "iife",
	plugins: [
		includePaths({
			include: {
				"preact": "preact/dist/preact.esm.js"
			},
			paths: ["src", "common", "client", "preact/dist"]
		}),
		rollupBabel({
			babelrc: false,
			plugins: [stripRedact(), rewriteForInStatements(babel)]
		})
	]
};
