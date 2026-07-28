// GENERATED FILE -- do not edit by hand.
// Source: kaitai/rmv6.ksy, compiled with kaitai-struct-compiler.
// Regenerate with: npm run generate:kaitai

// This is a generated file! Please edit source .ksy file and use kaitai-struct-compiler to rebuild

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['exports', 'kaitai-struct/KaitaiStream'], factory);
  } else if (typeof exports === 'object' && exports !== null && typeof exports.nodeType !== 'number') {
    factory(exports, require('kaitai-struct/KaitaiStream'));
  } else {
    factory(root.Rmv6 || (root.Rmv6 = {}), root.KaitaiStream);
  }
})(typeof self !== 'undefined' ? self : this, function (Rmv6_, KaitaiStream) {
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
    var i = 0;
    while (!this._io.isEof()) {
      this.blocks.push(new Block(this._io, this, this._root));
      i++;
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
      switch (this.blockType) {
      case Rmv6.BlockTypes.GLYPH_DEF:
        this._raw_body = this._io.readBytes(this.lenBody);
        var _io__raw_body = new KaitaiStream(this._raw_body);
        this.body = new RmRawBody(_io__raw_body, this, this._root);
        break;
      case Rmv6.BlockTypes.LAYER_DEF:
        this._raw_body = this._io.readBytes(this.lenBody);
        var _io__raw_body = new KaitaiStream(this._raw_body);
        this.body = new RmLayerDefinition(_io__raw_body, this, this._root);
        break;
      case Rmv6.BlockTypes.LAYER_INFO:
        this._raw_body = this._io.readBytes(this.lenBody);
        var _io__raw_body = new KaitaiStream(this._raw_body);
        this.body = new RmLayerInfo(_io__raw_body, this, this._root);
        break;
      case Rmv6.BlockTypes.LAYER_NAMES:
        this._raw_body = this._io.readBytes(this.lenBody);
        var _io__raw_body = new KaitaiStream(this._raw_body);
        this.body = new RmLayerName(_io__raw_body, this, this._root);
        break;
      case Rmv6.BlockTypes.LINE_DEF:
        this._raw_body = this._io.readBytes(this.lenBody);
        var _io__raw_body = new KaitaiStream(this._raw_body);
        this.body = new RmRawBody(_io__raw_body, this, this._root);
        break;
      case Rmv6.BlockTypes.SCENE_INFO:
        this._raw_body = this._io.readBytes(this.lenBody);
        var _io__raw_body = new KaitaiStream(this._raw_body);
        this.body = new RmRawBody(_io__raw_body, this, this._root);
        break;
      case Rmv6.BlockTypes.TEXT_DEF:
        this._raw_body = this._io.readBytes(this.lenBody);
        var _io__raw_body = new KaitaiStream(this._raw_body);
        this.body = new RmRawBody(_io__raw_body, this, this._root);
        break;
      default:
        this._raw_body = this._io.readBytes(this.lenBody);
        var _io__raw_body = new KaitaiStream(this._raw_body);
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
   * Defines each layer's id.
   */

  var RmLayerDefinition = Rmv6.RmLayerDefinition = (function() {
    function RmLayerDefinition(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    RmLayerDefinition.prototype._read = function() {
      this.magic0 = this._io.readBytes(1);
      if (!((KaitaiStream.byteArrayCompare(this.magic0, new Uint8Array([31])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([31]), this.magic0, this._io, "/types/rm_layer_definition/seq/0");
      }
      this.layerId = this._io.readBytesTerm(47, false, false, true);
      this.magic1 = this._io.readBytes(1);
      if (!((KaitaiStream.byteArrayCompare(this.magic1, new Uint8Array([47])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([47]), this.magic1, this._io, "/types/rm_layer_definition/seq/2");
      }
      this.unknown00 = this._io.readBytesTerm(76, false, false, true);
      this.magic2 = this._io.readBytes(1);
      if (!((KaitaiStream.byteArrayCompare(this.magic2, new Uint8Array([76])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([76]), this.magic2, this._io, "/types/rm_layer_definition/seq/4");
      }
      this.lenUnknown = this._io.readU4le();
      this.magic3 = this._io.readBytes(1);
      if (!((KaitaiStream.byteArrayCompare(this.magic3, new Uint8Array([31])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([31]), this.magic3, this._io, "/types/rm_layer_definition/seq/6");
      }
      this._unnamed7 = [];
      var i = 0;
      while (!this._io.isEof()) {
        this._unnamed7.push(this._io.readBytes(1));
        i++;
      }
    }

    /**
     * Identifier for this layer that appears in other structures in reference
     * to this layer. There are some data types (defined below) that have 
     * fields with layer ids that appear to be incremented by 1 or 2. Eg, for 
     * a `layer_id` of `00 0b` a field may have `00 0c` or `00 0d`. What this 
     * means is still unclear.
     */

    /**
     * This byte count refers to the remainder of the block, but it is
     * unclear what is present in that space.
     */

    return RmLayerDefinition;
  })();

  /**
   * This is the final of the three types of blocks related to layers.
   * Most of the fields appear to be in the `layer_id` style (see 
   * `rm_layer_definition`) and may include the aforementioned incremented
   * ids. I am not sure of the function of this block at the moment.
   */

  var RmLayerInfo = Rmv6.RmLayerInfo = (function() {
    function RmLayerInfo(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    RmLayerInfo.prototype._read = function() {
      this.magic0 = this._io.readBytes(1);
      if (!((KaitaiStream.byteArrayCompare(this.magic0, new Uint8Array([31])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([31]), this.magic0, this._io, "/types/rm_layer_info/seq/0");
      }
      this.idField1 = this._io.readU2le();
      this.magic2f = this._io.readBytes(1);
      if (!((KaitaiStream.byteArrayCompare(this.magic2f, new Uint8Array([47])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([47]), this.magic2f, this._io, "/types/rm_layer_info/seq/2");
      }
      this.idField2 = this._io.readBytesTerm(63, false, false, true);
      this.magic3f = this._io.readBytes(1);
      if (!((KaitaiStream.byteArrayCompare(this.magic3f, new Uint8Array([63])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([63]), this.magic3f, this._io, "/types/rm_layer_info/seq/4");
      }
      this.idField3 = this._io.readBytesTerm(79, false, false, true);
      this.magic4f = this._io.readBytes(1);
      if (!((KaitaiStream.byteArrayCompare(this.magic4f, new Uint8Array([79])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([79]), this.magic4f, this._io, "/types/rm_layer_info/seq/6");
      }
      this.idField4 = this._io.readU2le();
      this.magic54 = this._io.readBytes(1);
      if (!((KaitaiStream.byteArrayCompare(this.magic54, new Uint8Array([84])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([84]), this.magic54, this._io, "/types/rm_layer_info/seq/8");
      }
      this.doneFlag = this._io.readU4le();
      if (this.doneFlag == 0) {
        this.magic6c = this._io.readBytes(1);
        if (!((KaitaiStream.byteArrayCompare(this.magic6c, new Uint8Array([108])) == 0))) {
          throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([108]), this.magic6c, this._io, "/types/rm_layer_info/seq/10");
        }
      }
      if (this.doneFlag == 0) {
        this.lenAlways4 = this._io.readBytes(4);
      }
      if (this.doneFlag == 0) {
        this.magic = this._io.readBytes(2);
        if (!((KaitaiStream.byteArrayCompare(this.magic, new Uint8Array([2, 47])) == 0))) {
          throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([2, 47]), this.magic, this._io, "/types/rm_layer_info/seq/12");
        }
      }
      if (this.doneFlag == 0) {
        this.layerId = this._io.readU2le();
      }
    }

    /**
     * This is definitely a byte count, but is always 4.
     */

    /**
     * If present, this is appears to be the actual identifier of the layer
     * in question.
     */

    return RmLayerInfo;
  })();

  /**
   * The primary purpose of this block is to match textual names to
   * their associated layer ids. There is additional data here as well,
   * but it's not clear what it means. Also, once in a while there is
   * even more data at the end of this block that might be related to
   * either the bold/italic formatting, or the forced moving of drawn
   * lines when text is added.
   */

  var RmLayerName = Rmv6.RmLayerName = (function() {
    function RmLayerName(_io, _parent, _root) {
      this._io = _io;
      this._parent = _parent;
      this._root = _root;

      this._read();
    }
    RmLayerName.prototype._read = function() {
      this.magic0 = this._io.readBytes(1);
      if (!((KaitaiStream.byteArrayCompare(this.magic0, new Uint8Array([31])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([31]), this.magic0, this._io, "/types/rm_layer_name/seq/0");
      }
      this.id = this._io.readBytesTerm(44, false, false, true);
      this.magic1 = this._io.readBytes(1);
      if (!((KaitaiStream.byteArrayCompare(this.magic1, new Uint8Array([44])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([44]), this.magic1, this._io, "/types/rm_layer_name/seq/2");
      }
      this.lenRest0 = this._io.readU4le();
      this.magic2 = this._io.readBytes(1);
      if (!((KaitaiStream.byteArrayCompare(this.magic2, new Uint8Array([31])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([31]), this.magic2, this._io, "/types/rm_layer_name/seq/4");
      }
      this._unnamed5 = this._io.readBytes(2);
      this.magic3 = this._io.readBytes(1);
      if (!((KaitaiStream.byteArrayCompare(this.magic3, new Uint8Array([44])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([44]), this.magic3, this._io, "/types/rm_layer_name/seq/6");
      }
      this.lenRest1 = this._io.readU4le();
      this.lenName = this._io.readU1();
      this.magic4 = this._io.readBytes(1);
      if (!((KaitaiStream.byteArrayCompare(this.magic4, new Uint8Array([1])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([1]), this.magic4, this._io, "/types/rm_layer_name/seq/9");
      }
      this.name = KaitaiStream.bytesToStr(this._io.readBytes(this.lenName), "UTF-8");
      this.magic5 = this._io.readBytes(1);
      if (!((KaitaiStream.byteArrayCompare(this.magic5, new Uint8Array([60])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([60]), this.magic5, this._io, "/types/rm_layer_name/seq/11");
      }
      this.lenUnknown = this._io.readU4le();
      this.magic6 = this._io.readBytes(1);
      if (!((KaitaiStream.byteArrayCompare(this.magic6, new Uint8Array([31])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([31]), this.magic6, this._io, "/types/rm_layer_name/seq/13");
      }
      this._unnamed14 = this._io.readBytes(2);
      this.magic7 = this._io.readBytes(2);
      if (!((KaitaiStream.byteArrayCompare(this.magic7, new Uint8Array([33, 1])) == 0))) {
        throw new KaitaiStream.ValidationNotEqualError(new Uint8Array([33, 1]), this.magic7, this._io, "/types/rm_layer_name/seq/15");
      }
    }

    /**
     * The layer's identifier.
     */

    /**
     * Byte length from here to magic_5 (3c)
     */

    /**
     * This appears to be id plus 1. An id of `01 11` becomes `01 12`
     * here for some reason
     */

    /**
     * Byte length from here to magic_5 (3c)
     */

    /**
     * Single byte length of the layer name as a string.
     */

    /**
     * 01 byte marks the start of a string.
     */

    /**
     * This byte count refers to the remainder of the block, but it is
     * unclear what is present in that space.
     */

    return RmLayerName;
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
Rmv6_.Rmv6 = Rmv6;
});
