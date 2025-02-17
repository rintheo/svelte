/** @import { Visitors } from 'zimmerframe' */
/** @import { ValidatedCompileOptions, Css } from '#compiler' */
/** @import { ComponentAnalysis } from '../../types.js' */
import MagicString from 'magic-string';
import { walk } from 'zimmerframe';
import { is_keyframes_node, regex_css_name_boundary, remove_css_prefix } from '../../css.js';
import { merge_with_preprocessor_map } from '../../../utils/mapped_code.js';
import { dev } from '../../../state.js';

/**
 * @typedef {{
 *   code: MagicString;
 *   hash: string;
 *   selector: string;
 *   keyframes: string[];
 *   specificity: {
 *     bumped: boolean
 *   }
 * }} State
 */

/**
 *
 * @param {string} source
 * @param {ComponentAnalysis} analysis
 * @param {ValidatedCompileOptions} options
 */
export function render_stylesheet(source, analysis, options) {
	const code = new MagicString(source);

	/** @type {State} */
	const state = {
		code,
		hash: analysis.css.hash,
		selector: `.${analysis.css.hash}`,
		keyframes: analysis.css.keyframes,
		specificity: {
			bumped: false
		}
	};

	const ast = /** @type {Css.StyleSheet} */ (analysis.css.ast);

	walk(/** @type {Css.Node} */ (ast), state, visitors);

	code.remove(0, ast.content.start);
	code.remove(/** @type {number} */ (ast.content.end), source.length);

	const css = {
		code: code.toString(),
		map: code.generateMap({
			// include source content; makes it easier/more robust looking up the source map code
			includeContent: true,
			// generateMap takes care of calculating source relative to file
			source: options.filename,
			file: options.cssOutputFilename || options.filename
		})
	};

	merge_with_preprocessor_map(css, options, css.map.sources[0]);

	if (dev && options.css === 'injected' && css.code) {
		css.code += `\n/*# sourceMappingURL=${css.map.toUrl()} */`;
	}

	return css;
}

/** @type {Visitors<Css.Node, State>} */
const visitors = {
	_: (node, context) => {
		context.state.code.addSourcemapLocation(node.start);
		context.state.code.addSourcemapLocation(node.end);
		context.next();
	},
	Atrule(node, { state, next }) {
		if (is_keyframes_node(node)) {
			let start = node.start + node.name.length + 1;
			while (state.code.original[start] === ' ') start += 1;
			let end = start;
			while (state.code.original[end] !== '{' && state.code.original[end] !== ' ') end += 1;

			if (node.prelude.startsWith('-global-')) {
				state.code.remove(start, start + 8);
			} else {
				state.code.prependRight(start, `${state.hash}-`);
			}

			return; // don't transform anything within
		}

		next();
	},
	Declaration(node, { state }) {
		const property = node.property && remove_css_prefix(node.property.toLowerCase());
		if (property === 'animation' || property === 'animation-name') {
			let index = node.start + node.property.length + 1;
			let name = '';

			while (index < state.code.original.length) {
				const character = state.code.original[index];

				if (regex_css_name_boundary.test(character)) {
					if (state.keyframes.includes(name)) {
						state.code.prependRight(index - name.length, `${state.hash}-`);
					}

					if (character === ';' || character === '}') {
						break;
					}

					name = '';
				} else {
					name += character;
				}

				index++;
			}
		}
	},
	Rule(node, { state, next, visit }) {
		// keep empty rules in dev, because it's convenient to
		// see them in devtools
		if (!dev && is_empty(node)) {
			state.code.prependRight(node.start, '/* (empty) ');
			state.code.appendLeft(node.end, '*/');
			escape_comment_close(node, state.code);
			return;
		}

		if (!is_used(node)) {
			state.code.prependRight(node.start, '/* (unused) ');
			state.code.appendLeft(node.end, '*/');
			escape_comment_close(node, state.code);

			return;
		}

		if (node.metadata.is_global_block) {
			const selector = node.prelude.children[0];

			if (selector.children.length === 1 && selector.children[0].selectors.length === 1) {
				// `:global {...}`
				state.code.prependRight(node.start, '/* ');
				state.code.appendLeft(node.block.start + 1, '*/');

				state.code.prependRight(node.block.end - 1, '/*');
				state.code.appendLeft(node.block.end, '*/');

				// don't recurse into selector or body
				return;
			}

			// don't recurse into body
			visit(node.prelude);
			return;
		}

		next();
	},
	SelectorList(node, { state, next, path }) {
		// Only add comments if we're not inside a complex selector that itself is unused
		if (!path.find((n) => n.type === 'ComplexSelector' && !n.metadata.used)) {
			let pruning = false;
			let last = node.children[0].start;

			for (let i = 0; i < node.children.length; i += 1) {
				const selector = node.children[i];

				if (selector.metadata.used === pruning) {
					if (pruning) {
						let i = selector.start;
						while (state.code.original[i] !== ',') i--;

						state.code.overwrite(i, i + 1, '*/');
					} else {
						if (i === 0) {
							state.code.prependRight(selector.start, '/* (unused) ');
						} else {
							state.code.overwrite(last, selector.start, ' /* (unused) ');
						}
					}

					pruning = !pruning;
				}

				last = selector.end;
			}

			if (pruning) {
				state.code.appendLeft(last, '*/');
			}
		}

		// if we're in a `:is(...)` or whatever, keep existing specificity bump state
		let specificity = state.specificity;

		// if this selector list belongs to a rule, require a specificity bump for the
		// first scoped selector but only if we're at the top level
		let parent = path.at(-1);
		if (parent?.type === 'Rule') {
			specificity = { bumped: false };

			/** @type {Css.Rule | null} */
			let rule = parent.metadata.parent_rule;

			while (rule) {
				if (rule.metadata.has_local_selectors) {
					specificity = { bumped: true };
					break;
				}
				rule = rule.metadata.parent_rule;
			}
		}

		next({ ...state, specificity });
	},
	ComplexSelector(node, context) {
		const before_bumped = context.state.specificity.bumped;

		/**
		 * @param {Css.PseudoClassSelector} selector
		 * @param {Css.Combinator | null} combinator
		 */
		function remove_global_pseudo_class(selector, combinator) {
			if (selector.args === null) {
				let start = selector.start;
				if (combinator?.name === ' ') {
					// div :global.x becomes div.x
					while (/\s/.test(context.state.code.original[start - 1])) start--;
				}
				context.state.code.remove(start, selector.start + ':global'.length);
			} else {
				context.state.code
					.remove(selector.start, selector.start + ':global('.length)
					.remove(selector.end - 1, selector.end);
			}
		}

		for (const relative_selector of node.children) {
			if (relative_selector.metadata.is_global) {
				const global = /** @type {Css.PseudoClassSelector} */ (relative_selector.selectors[0]);
				remove_global_pseudo_class(global, relative_selector.combinator);

				if (
					node.metadata.rule?.metadata.parent_rule &&
					global.args === null &&
					relative_selector.combinator === null
				) {
					// div { :global.x { ... } } becomes div { &.x { ... } }
					context.state.code.prependRight(global.start, '&');
				}
				continue;
			}

			if (relative_selector.metadata.scoped) {
				if (relative_selector.selectors.length === 1) {
					// skip standalone :is/:where/& selectors
					const selector = relative_selector.selectors[0];
					if (
						selector.type === 'PseudoClassSelector' &&
						(selector.name === 'is' || selector.name === 'where')
					) {
						continue;
					}
				}

				// for any :global() or :global at the middle of compound selector
				for (const selector of relative_selector.selectors) {
					if (selector.type === 'PseudoClassSelector' && selector.name === 'global') {
						remove_global_pseudo_class(selector, null);
					}
				}

				if (relative_selector.selectors.some((s) => s.type === 'NestingSelector')) {
					continue;
				}

				// for the first occurrence, we use a classname selector, so that every
				// encapsulated selector gets a +0-1-0 specificity bump. thereafter,
				// we use a `:where` selector, which does not affect specificity
				let modifier = context.state.selector;
				if (context.state.specificity.bumped) modifier = `:where(${modifier})`;

				context.state.specificity.bumped = true;

				let i = relative_selector.selectors.length;
				while (i--) {
					const selector = relative_selector.selectors[i];

					if (
						selector.type === 'PseudoElementSelector' ||
						selector.type === 'PseudoClassSelector'
					) {
						if (selector.name !== 'root' && selector.name !== 'host') {
							if (i === 0) context.state.code.prependRight(selector.start, modifier);
						}
						continue;
					}

					if (selector.type === 'TypeSelector' && selector.name === '*') {
						context.state.code.update(selector.start, selector.end, modifier);
					} else {
						context.state.code.appendLeft(selector.end, modifier);
					}

					break;
				}
			}
		}

		context.next();

		context.state.specificity.bumped = before_bumped;
	},
	PseudoClassSelector(node, context) {
		if (node.name === 'is' || node.name === 'where' || node.name === 'has' || node.name === 'not') {
			context.next();
		}
	}
};

/** @param {Css.Rule} rule */
function is_empty(rule) {
	if (rule.metadata.is_global_block) {
		return rule.block.children.length === 0;
	}

	for (const child of rule.block.children) {
		if (child.type === 'Declaration') {
			return false;
		}

		if (child.type === 'Rule') {
			if (is_used(child) && !is_empty(child)) return false;
		}

		if (child.type === 'Atrule') {
			if (child.block === null || child.block.children.length > 0) return false;
		}
	}

	return true;
}

/** @param {Css.Rule} rule */
function is_used(rule) {
	return rule.prelude.children.some((selector) => selector.metadata.used);
}

/**
 *
 * @param {Css.Rule} node
 * @param {MagicString} code
 */
function escape_comment_close(node, code) {
	let escaped = false;
	let in_comment = false;

	for (let i = node.start; i < node.end; i++) {
		if (escaped) {
			escaped = false;
		} else {
			const char = code.original[i];
			if (in_comment) {
				if (char === '*' && code.original[i + 1] === '/') {
					code.prependRight(++i, '\\');
					in_comment = false;
				}
			} else if (char === '\\') {
				escaped = true;
			} else if (char === '/' && code.original[++i] === '*') {
				in_comment = true;
			}
		}
	}
}
