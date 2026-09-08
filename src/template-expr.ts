// The expression language a reMarkable template is written in. Anywhere a template expects a number
// -- a bounding box edge, a coordinate inside a path, a stroke width, a repeat count -- it may carry
// a string instead, and that string is arithmetic over the template's own declared constants and a
// handful of names the device injects (`templateWidth`, `paperOriginX`, ...). That is how one file
// rules a 1404 px screen and a 1620 px one at the same physical pitch.
//
// **A real parser, not `Function()` or `eval`.** The two published community renderers both build a
// JavaScript function out of the string. This runs inside Obsidian's renderer over a file that came
// from somebody's cloud account, so that is not available to us; and the cost of not having it is
// about eighty lines.
//
// **Both branches of a ternary are evaluated.** That is deliberate, not an oversight: an expression
// naming an identifier we do not know is a template we cannot draw, and the template has to fail as
// a whole rather than fail later on a page whose page size happened to pick the other branch.

export class TemplateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TemplateError";
	}
}

/** Every name an expression may use: the device-injected ones plus the template's own constants. */
export type ExprScope = Readonly<Record<string, number>>;

/** Numbers, identifiers, two-character operators before one-character ones. */
const TOKEN = /\s*(\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|&&|\|\||[<>=!]=|[-+*/()?:<>])/y;

function tokenise(source: string): string[] {
	const trimmed = source.trim();
	const tokens: string[] = [];
	let at = 0;
	while (at < trimmed.length) {
		TOKEN.lastIndex = at;
		const match = TOKEN.exec(trimmed);
		if (match === null) throw new TemplateError(`unreadable character at ${at} of expression ${JSON.stringify(source)}`);
		tokens.push(match[1]);
		at = TOKEN.lastIndex;
	}
	return tokens;
}

/**
 * Evaluates one expression against `scope`. Throws {@link TemplateError} for anything it cannot
 * read -- a stray character, a missing operand, or a name that is neither a declared constant nor
 * one of the injected builtins.
 *
 * Comparisons yield 1 and 0; `&&` and `||` keep JavaScript's own "return an operand" semantics,
 * because the templates were written against a renderer that used them.
 */
export function evaluateExpression(source: string, scope: ExprScope): number {
	return new ExpressionReader(tokenise(source), scope, source).read();
}

class ExpressionReader {
	private at = 0;

	constructor(
		private readonly tokens: readonly string[],
		private readonly scope: ExprScope,
		private readonly source: string,
	) {}

	read(): number {
		if (this.tokens.length === 0) throw this.fail("nothing to evaluate");
		const value = this.ternary();
		if (this.at < this.tokens.length) throw this.fail(`unexpected "${this.tokens[this.at]}"`);
		return value;
	}

	private fail(what: string): TemplateError {
		return new TemplateError(`${what} in expression ${JSON.stringify(this.source)}`);
	}

	private take(token: string): boolean {
		if (this.tokens[this.at] !== token) return false;
		this.at++;
		return true;
	}

	private ternary(): number {
		const condition = this.or();
		if (!this.take("?")) return condition;
		const whenTrue = this.ternary();
		if (!this.take(":")) throw this.fail('expected ":"');
		const whenFalse = this.ternary();
		return condition !== 0 ? whenTrue : whenFalse;
	}

	private or(): number {
		let left = this.and();
		while (this.take("||")) {
			const right = this.and();
			left = left !== 0 ? left : right;
		}
		return left;
	}

	private and(): number {
		let left = this.equality();
		while (this.take("&&")) {
			const right = this.equality();
			left = left !== 0 ? right : left;
		}
		return left;
	}

	private equality(): number {
		let left = this.comparison();
		for (;;) {
			if (this.take("==")) left = left === this.comparison() ? 1 : 0;
			else if (this.take("!=")) left = left !== this.comparison() ? 1 : 0;
			else return left;
		}
	}

	private comparison(): number {
		let left = this.additive();
		for (;;) {
			if (this.take("<=")) left = left <= this.additive() ? 1 : 0;
			else if (this.take(">=")) left = left >= this.additive() ? 1 : 0;
			else if (this.take("<")) left = left < this.additive() ? 1 : 0;
			else if (this.take(">")) left = left > this.additive() ? 1 : 0;
			else return left;
		}
	}

	private additive(): number {
		let left = this.multiplicative();
		for (;;) {
			if (this.take("+")) left += this.multiplicative();
			else if (this.take("-")) left -= this.multiplicative();
			else return left;
		}
	}

	private multiplicative(): number {
		let left = this.unary();
		for (;;) {
			if (this.take("*")) left *= this.unary();
			else if (this.take("/")) left /= this.unary();
			else return left;
		}
	}

	private unary(): number {
		if (this.take("-")) return -this.unary();
		if (this.take("+")) return this.unary();
		return this.primary();
	}

	private primary(): number {
		const token = this.tokens[this.at];
		if (token === undefined) throw this.fail("expression ends early");
		this.at++;
		if (token === "(") {
			const value = this.ternary();
			if (!this.take(")")) throw this.fail('expected ")"');
			return value;
		}
		if (/^\d/.test(token)) return Number(token);
		if (/^[A-Za-z_]/.test(token)) {
			const value = this.scope[token];
			if (value === undefined) throw this.fail(`unknown name "${token}"`);
			return value;
		}
		throw this.fail(`unexpected "${token}"`);
	}
}
