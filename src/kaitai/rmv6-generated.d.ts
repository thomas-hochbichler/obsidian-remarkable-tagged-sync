// Hand-written types for `rmv6-generated.js`, which kaitai-struct-compiler emits as plain JS with
// no declarations. Before this file existed, `rm-parser.ts` imported the class with a
// `@ts-expect-error` and every property read off it was untyped -- 23 `no-unsafe-*` lint problems,
// and no compiler help at all on a binary format where a wrong field name fails silently.
//
// This declares only the surface `rm-parser.ts` actually uses, and it is a *contract check*, not a
// mirror: the shapes come from the `.ksy` schema, which is the stable thing. If you regenerate the
// parser (`npm run generate:kaitai`) after editing `rmv6.ksy`, update this file too -- a mismatch
// surfaces as a type error in `rm-parser.ts`, which is exactly the intent. See PROVENANCE.md.

/** Byte string read by the generated parser; kaitai returns raw bytes for unterminated fields. */
type Bytes = Uint8Array;

/** A block whose payload is left unparsed, for the parser in `rm-parser.ts` to walk by hand. */
interface RmRawBody {
	raw: Bytes;
}

/**
 * One block of the scene stream. Every block type this schema models keeps its body raw (an
 * `RmRawBody`) for `rm-parser.ts` to hand-parse; a block type it does not model gets an empty
 * body, which the parser's own `switch` never reads.
 */
interface Block {
	lenBody: number;
	unknownFlag: number;
	minVersion: number;
	currentVersion: number;
	blockType: number;
	body: RmRawBody;
}

interface RmFrontmatterHeader {
	/** Parsed out of the file's version string; `NaN` if that string is not numeric. */
	versionNumber: number;
	versionString: string;
}

interface RmFrontmatter {
	header: RmFrontmatterHeader;
}

export class Rmv6 {
	constructor(io: unknown);
	frontmatter: RmFrontmatter;
	blocks: Block[];

	/** Both directions: name → id and id → name, as `Object.freeze`d by the generator. */
	static readonly BlockTypes: {
		readonly LAYER_DEF: 1;
		readonly LAYER_NAMES: 2;
		readonly GLYPH_DEF: 3;
		readonly LAYER_INFO: 4;
		readonly LINE_DEF: 5;
		readonly TEXT_DEF: 7;
		readonly SCENE_INFO: 13;
		readonly IMAGE_TABLE: 14;
		readonly IMAGE_DEF: 15;
	};
}

