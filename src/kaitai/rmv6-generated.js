// GENERATED FILE -- do not edit by hand.
// Source: kaitai/rmv6.ksy, compiled with kaitai-struct-compiler, post-processed below.
// Regenerate with: npm run generate:kaitai

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- generated parser (see PROVENANCE.md): internals read from the untyped kaitai-struct runtime; the public surface is typed by rmv6-generated.d.ts */
import KaitaiStream from "kaitai-struct/KaitaiStream";

/**
 * Spec for the ReMarkable tablet's notebook/annotation file format.
 * 
 * This spec recognizes only the current format (v6) utilized by ReMarkable
 * firmware versions 3.x. See references for specs for previous versions.
 */

var Rmv6 = (function() {
  Rmv6.BlockTypes = Object.freeze({
    LAYER_DEF: 1,
    LAYER_NAMES: 2,
    GLYPH_DEF: 3,
    LAYER_INFO: 4,
    LINE_DEF: 5,
    TEXT_DEF: 7,
    SCENE_INFO: 13,

    1: "LAYER_DEF",
    2: "LAYER_NAMES",
    3: "GLYPH_DEF",
    4: "LAYER_INFO",
    5: "LINE_DEF",
    7: "TEXT_DEF",
    13: "SCENE_INFO",
  });

  function Rmv6(_io, _parent, _root) {
    this._io = _io;
    this._parent = _parent;
    this._root = _root || this;

    this._read();
  }
  Rmv6.prototype._read = function() {
    this.frontmatter = new RmFrontmatter(this._io, this, this._root);
    this.blocks = [];
    while (!this._io.isEof()) {
      this.blocks.push(new Block(this._io, this, this._root));
    }
  }

  /**
   * A block of data, storing some major structure of the format.
   * 
   * Blocks follow a size-type-value scheme, where a size (`len_body`)
   * describes the byte length of the block's held value (`body`) and
   * the value's type (`block_type`, see enum `block_types`).
   */

  var Block = Rmv6.Block = (function() {
    function Block(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    Block.prototype._read = function() {
      this.lenBody = this._io.readU4le();
      this.unknownFlag = this._io.readU1();
      this.minVersion = this._io.readU1();
      this.currentVersion = this._io.readU1();
      this.blockType = this._io.readU1();
      var _io__raw_body;
      switch (this.blockType) {
      case Rmv6.BlockTypes.GLYPH_DEF:
        this._raw_body = this._io.readBytes(this.lenBody);
        _io__raw_body = new KaitaiStream(this._raw_body);
        this.body = new RmRawBody(_io__raw_body, this, this._root);
        break;
      case Rmv6.BlockTypes.LAYER_DEF:
        this._raw_body = this._io.readBytes(this.lenBody);
        _io__raw_body = new KaitaiStream(this._raw_body);
        this.body = new RmRawBody(_io__raw_body, this, this._root);
        break;
      case Rmv6.BlockTypes.LAYER_INFO:
        this._raw_body = this._io.readBytes(this.lenBody);
        _io__raw_body = new KaitaiStream(this._raw_body);
        this.body = new RmRawBody(_io__raw_body, this, this._root);
        break;
      case Rmv6.BlockTypes.LAYER_NAMES:
        this._raw_body = this._io.readBytes(this.lenBody);
        _io__raw_body = new KaitaiStream(this._raw_body);
        this.body = new RmRawBody(_io__raw_body, this, this._root);
        break;
      case Rmv6.BlockTypes.LINE_DEF:
        this._raw_body = this._io.readBytes(this.lenBody);
        _io__raw_body = new KaitaiStream(this._raw_body);
        this.body = new RmRawBody(_io__raw_body, this, this._root);
        break;
      case Rmv6.BlockTypes.SCENE_INFO:
        this._raw_body = this._io.readBytes(this.lenBody);
        _io__raw_body = new KaitaiStream(this._raw_body);
        this.body = new RmRawBody(_io__raw_body, this, this._root);
        break;
      case Rmv6.BlockTypes.TEXT_DEF:
        this._raw_body = this._io.readBytes(this.lenBody);
        _io__raw_body = new KaitaiStream(this._raw_body);
        this.body = new RmRawBody(_io__raw_body, this, this._root);
        break;
      default:
        this._raw_body = this._io.readBytes(this.lenBody);
        _io__raw_body = new KaitaiStream(this._raw_body);
        this.body = new Empty(_io__raw_body, this, this._root);
        break;
      }
    }

    /**
     * Byte count for block's main body.
     */

    /**
     * Always observed as 0. Meaning not reverse-engineered.
     */

    /**
     * Informational; not part of the block's type (see `block_type`).
     */

    /**
     * Informational; not part of the block's type (see `block_type`).
     */

    /**
     * Discriminant for the value stored in the block body. See enum
     * `block_types`.
     */

    /**
     * Contains inner value of block.
     */

    return Block;
  })();

  var Empty = Rmv6.Empty = (function() {
    function Empty(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    Empty.prototype._read = function() {
    }

    return Empty;
  })();

  /**
   * The frontmatter at the top of the file: just the version header.
   * 
   * NOTE (clean-room correction, not present in the upstream YakBarber/
   * remarkable_file_format spec): the upstream .ksy modeled a further ~120
   * bytes after the header as a fixed "boilerplate" struct (magic_1,
   * dupe_flip_1/2, x4_chunks, active_layer, ...). Byte-comparing several
   * real v6 fixtures (see /test-fixtures/rmv6) showed that content is not
   * fixed at all -- it varies per file in both value and apparent
   * structure, and its layout (length-prefixed, then a 4-byte tag) is
   * identical to the ordinary top-level `block` structure defined below.
   * Cross-checked against rmscene (ricklupton/rmscene, MIT), whose reader
   * also treats everything after the header as an ordinary block stream
   * with no special frontmatter section. So here we only parse the fixed
   * 43-byte header; the bytes the upstream spec mismodeled are left to be
   * consumed by the top-level `blocks` sequence as ordinary blocks (most
   * fall through the `block` type's `_: empty` case, since their block
   * flag isn't one this spec decodes further).
   */

  var RmFrontmatter = Rmv6.RmFrontmatter = (function() {
    function RmFrontmatter(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    RmFrontmatter.prototype._read = function() {
      this._raw_header = this._io.readBytes(43);
      var _io__raw_header = new KaitaiStream(this._raw_header);
      this.header = new RmFrontmatterHeader(_io__raw_header, this, this._root);
    }

    return RmFrontmatter;
  })();

  var RmFrontmatterHeader = Rmv6.RmFrontmatterHeader = (function() {
    function RmFrontmatterHeader(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    RmFrontmatterHeader.prototype._read = function() {
      this.magicText = this._io.readBytes(32);
      if (!((KaitaiStream.byteArrayCompare(this.magicText, new Uint8Array([114, 101, 77, 97, 114, 107, 97, 98, 108, 101, 32, 46, 108, 105, 110, 101, 115, 32, 102, 105, 108, 101, 44, 32, 118, 101, 114, 115, 105, 111, 110, 61])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([114, 101, 77, 97, 114, 107, 97, 98, 108, 101, 32, 46, 108, 105, 110, 101, 115, 32, 102, 105, 108, 101, 44, 32, 118, 101, 114, 115, 105, 111, 110, 61]), this.magicText, this._io, "/types/rm_frontmatter_header/seq/0");
      }
      this.versionString = KaitaiStream.bytesToStr(this._io.readBytes(1), "UTF-8");
      this.tenSpaces = this._io.readBytes(10);
      if (!((KaitaiStream.byteArrayCompare(this.tenSpaces, new Uint8Array([32, 32, 32, 32, 32, 32, 32, 32, 32, 32])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([32, 32, 32, 32, 32, 32, 32, 32, 32, 32]), this.tenSpaces, this._io, "/types/rm_frontmatter_header/seq/2");
      }
    }
    Object.defineProperty(RmFrontmatterHeader.prototype, 'versionNumber', {
      get: function() {
        if (this._m_versionNumber !== undefined)
          return this._m_versionNumber;
        this._m_versionNumber = Number.parseInt(this.versionString, 10);
        return this._m_versionNumber;
      }
    });

    /**
     * Version number, but encoded as a single UTF-8 character.
     */

    return RmFrontmatterHeader;
  })();

  /**
   * Opaque capture of a block body that this spec does not decode further.
   * 
   * Used for `line_def` (stroke) bodies: the upstream spec's `rm_line`/
   * `rm_line_header` modeled these as fixed-offset fields with hardcoded
   * "magic" bytes, but real files encode this body as a CRDT tagged-value
   * stream (tag byte = index<<4 | type, per rmscene/tagged_block_common.py,
   * MIT) where several of those "magic" bytes are actually the low bytes of
   * variable-length values (e.g. a `min_version`/`current_version`-tagged
   * CrdtId, or an 8-byte double for line thickness that the upstream spec
   * misread as 4 padding bytes + a 4-byte float). That misreading validated
   * only by coincidence on whichever single sample file the upstream spec
   * was written against. The TypeScript adapter hand-parses this raw body
   * instead, cross-checked against rmscene's reader for the real tag
   * layout. See PROVENANCE.md.
   * 
   * Also used for `text_def` bodies, which are out of scope for this
   * parser's scene model (layers/strokes only); the upstream spec's text
   * types are left unused here.
   * 
   * Also used for `layer_info` bodies: the upstream spec's `rm_layer_info`
   * had the same fixed-width misreading (CrdtIds hardcoded as `u2`), which
   * threw a validation error -- aborting the whole page parse -- as soon as
   * a file's ids needed more than one varuint byte. The adapter never reads
   * this block, so its body stays raw and unparsed.
   * 
   * Also used for `layer_names` bodies, for the same reason: the former
   * `rm_layer_name` type hardcoded the label's LWW-timestamp CrdtId as 2
   * bytes. The adapter hand-parses the raw body to recover each layer's
   * name -- see `parseLayerNameBody` in rm-parser.ts.
   * 
   * Also used for `layer_def` bodies: the former `rm_layer_definition`
   * type scanned for fixed 0x2f/0x4c terminator bytes, which broke as soon
   * as a CrdtId's own encoding contained one of them. The adapter
   * hand-parses the raw body to recover each layer's id -- see
   * `parseLayerDefBody` in rm-parser.ts.
   */

  var RmRawBody = Rmv6.RmRawBody = (function() {
    function RmRawBody(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    RmRawBody.prototype._read = function() {
      this.raw = this._io.readBytesFull();
    }

    return RmRawBody;
  })();

  /**
   * Header and unknown boilerplate at the start of the file. The primary
   * information currently extracted from this section is the format version
   * (which should always be 6).
   */

  /**
   * Blocks contain the primary data structures of the file, and are in
   * size-type-value format. See the `block_flags` enum and `block` type.
   */

  return Rmv6;
})();
export { Rmv6 };
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- end of generated parser */
