meta:
  id: rmv6
  application: xochitl
  file-extension: rm
  license: MIT
  encoding: UTF-8
  endian: le

doc: |
  Spec for the ReMarkable tablet's notebook/annotation file format.

  This spec recognizes only the current format (v6) utilized by ReMarkable
  firmware versions 3.x. See references for specs for previous versions.


seq:
  - id: frontmatter
    type: rm_frontmatter
    doc: |
      Header and unknown boilerplate at the start of the file. The primary
      information currently extracted from this section is the format version
      (which should always be 6).

  - id: blocks
    type: block
    repeat: eos
    doc: |
      Blocks contain the primary data structures of the file, and are in
      size-type-value format. See the `block_flags` enum and `block` type.

enums:
  # NOTE (clean-room correction, not present in the upstream YakBarber/
  # remarkable_file_format spec): the upstream .ksy dispatched on the full
  # 4-byte block header (unknown byte + min_version + current_version +
  # block_type packed as one little-endian u4), with the version bytes
  # hardcoded to whatever one sample file happened to contain. Real fixtures
  # (see /test-fixtures/rmv6) contain the *same* block types tagged with
  # other min/current version numbers (e.g. line_def blocks tagged
  # min=1/current=1 as well as min=2/current=2), which the upstream enum
  # silently dropped into its `_: empty` fallback -- so stroke data (the
  # whole point of this parser) went unparsed. rmscene (ricklupton/rmscene,
  # MIT) confirms the block header's trailing byte alone is the type
  # discriminant; version numbers are informational, not part of the type.
  # So this spec now switches on that single trailing `block_type` byte.
  block_types:
    0x01:
      id: layer_def
      doc: |
        Initial enumeration of layers present, including the text layer
        (rmscene's `SceneTreeBlock`), one block per layer. Another CRDT
        tagged-value stream, so left as `rm_raw_body` and hand-parsed by the
        TypeScript adapter -- the former `rm_layer_definition` type here
        scanned for fixed 0x2f/0x4c terminator bytes, which a CrdtId
        containing either byte truncated, throwing on the misaligned bytes
        that followed and aborting the whole page parse.
    0x02:
      id: layer_names
      doc: |
        Names given to each layer, if present (rmscene's `TreeNodeBlock`),
        one block per layer. Another CRDT tagged-value stream, so left as
        `rm_raw_body` and hand-parsed by the TypeScript adapter -- the former
        `rm_layer_name` type here read the label's LWW-timestamp CrdtId as a
        fixed 2 bytes and threw on files whose timestamp needed more than one
        varuint byte, aborting the whole page parse.
    0x07:
      id: text_def
      doc: |
        The definition of typed text on the page (not handwriting). At most
        one block per page. Out of scope for this parser's scene model
        (layers/strokes only) and left undecoded as `rm_raw_body` -- the
        upstream spec's text-block types (chunk ids, formatting flags,
        backmatter) are also the least reliable part of the vendored spec
        (see PROVENANCE.md).
    0x04:
      id: layer_info
      doc: |
        A group item in the scene tree (rmscene's `SceneGroupItemBlock`),
        one block per layer. Another CRDT tagged-value stream whose CrdtIds
        are variable-length varuints, so left as `rm_raw_body` -- the former
        `rm_layer_info` type here read those ids as fixed-width `u2` and
        threw on files whose ids grew past one varuint byte. Not consumed by
        the TypeScript adapter at all.
    0x03:
      id: glyph_def
      doc: |
        A run of highlighted document text (rmscene's `GlyphRange`) -- what the
        reader writes when you select text in a PDF and highlight it, as opposed
        to the freehand marker strokes that arrive as `line_def`s. Carries the
        run's rectangles, so it is the only record of a text highlight's shape.
        Another CRDT tagged-value stream, so left as `rm_raw_body` and hand-parsed
        by the TypeScript adapter -- same reasoning as `line_def`.
    0x05:
      id: line_def
      doc: |
        Line definition (a pen stroke). Left as `rm_raw_body` -- see the
        note on `rm_raw_body` for why this isn't decoded by the generated
        parser -- and hand-parsed by the TypeScript adapter instead.
    0x0e:
      id: image_table
      doc: |
        Which file each of the page's images lives in, keyed by the 16 bytes
        the matching `image_def` carries. At most one block per page, and
        only on a page that has a picture on it -- an article imported by the
        "Read on reMarkable" Chrome extension is what puts one here. Another
        CRDT tagged-value stream, so left as `rm_raw_body` and hand-parsed by
        the TypeScript adapter -- same reasoning as `line_def`.
    0x0f:
      id: image_def
      doc: |
        One picture placed on the page: the key naming its file, and the quad
        it is drawn over. One block per image. Not in the upstream spec at
        all, and read off real files (see rm-parser.ts's `parseImageBody`).
        Another CRDT tagged-value stream, so left as `rm_raw_body` and
        hand-parsed by the TypeScript adapter -- same reasoning as `line_def`.
    0x0d:
      id: scene_info
      doc: |
        Scene-level info (rmscene's `SceneInfo`), at most one block per page.
        Carries the size in pixels of the device screen the page was drawn on,
        which is what tells the renderer that device's DPI. Another CRDT
        tagged-value stream, so left as `rm_raw_body` and hand-parsed by the
        TypeScript adapter -- same reasoning as `line_def`.

types:
  
  empty: {}
  
  block:
    doc: |
      A block of data, storing some major structure of the format.

      Blocks follow a size-type-value scheme, where a size (`len_body`)
      describes the byte length of the block's held value (`body`) and
      the value's type (`block_type`, see enum `block_types`).

    seq:
      - id: len_body
        type: u4
        doc: Byte count for block's main body.

      - id: unknown_flag
        type: u1
        doc: Always observed as 0. Meaning not reverse-engineered.

      - id: min_version
        type: u1
        doc: Informational; not part of the block's type (see `block_type`).

      - id: current_version
        type: u1
        doc: Informational; not part of the block's type (see `block_type`).

      - id: block_type
        type: u1
        enum: block_types
        doc: |
          Discriminant for the value stored in the block body. See enum
          `block_types`.

      - id: body
        size: len_body
        type:
          switch-on: block_type
          cases:
            'block_types::layer_def': rm_raw_body
            'block_types::layer_names': rm_raw_body
            'block_types::text_def': rm_raw_body
            'block_types::layer_info': rm_raw_body
            'block_types::line_def': rm_raw_body
            'block_types::glyph_def': rm_raw_body
            'block_types::scene_info': rm_raw_body
            'block_types::image_table': rm_raw_body
            'block_types::image_def': rm_raw_body
            _: empty
        doc: Contains inner value of block.

  rm_raw_body:
    doc: |
      Opaque capture of a block body that this spec does not decode further.

      Used for `line_def` (stroke) bodies: the upstream spec's `rm_line`/
      `rm_line_header` modeled these as fixed-offset fields with hardcoded
      "magic" bytes, but real files encode this body as a CRDT tagged-value
      stream (tag byte = index<<4 | type, per rmscene/tagged_block_common.py,
      MIT) where several of those "magic" bytes are actually the low bytes of
      variable-length values (e.g. a `min_version`/`current_version`-tagged
      CrdtId, or an 8-byte double for line thickness that the upstream spec
      misread as 4 padding bytes + a 4-byte float). That misreading validated
      only by coincidence on whichever single sample file the upstream spec
      was written against. The TypeScript adapter hand-parses this raw body
      instead, cross-checked against rmscene's reader for the real tag
      layout. See PROVENANCE.md.

      Also used for `text_def` bodies, which are out of scope for this
      parser's scene model (layers/strokes only); the upstream spec's text
      types are left unused here.

      Also used for `layer_info` bodies: the upstream spec's `rm_layer_info`
      had the same fixed-width misreading (CrdtIds hardcoded as `u2`), which
      threw a validation error -- aborting the whole page parse -- as soon as
      a file's ids needed more than one varuint byte. The adapter never reads
      this block, so its body stays raw and unparsed.

      Also used for `layer_names` bodies, for the same reason: the former
      `rm_layer_name` type hardcoded the label's LWW-timestamp CrdtId as 2
      bytes. The adapter hand-parses the raw body to recover each layer's
      name -- see `parseLayerNameBody` in rm-parser.ts.

      Also used for `layer_def` bodies: the former `rm_layer_definition`
      type scanned for fixed 0x2f/0x4c terminator bytes, which broke as soon
      as a CrdtId's own encoding contained one of them. The adapter
      hand-parses the raw body to recover each layer's id -- see
      `parseLayerDefBody` in rm-parser.ts.

    seq:
      - id: raw
        size-eos: true

  rm_frontmatter:
    doc: |
      The frontmatter at the top of the file: just the version header.

      NOTE (clean-room correction, not present in the upstream YakBarber/
      remarkable_file_format spec): the upstream .ksy modeled a further ~120
      bytes after the header as a fixed "boilerplate" struct (magic_1,
      dupe_flip_1/2, x4_chunks, active_layer, ...). Byte-comparing several
      real v6 fixtures (see /test-fixtures/rmv6) showed that content is not
      fixed at all -- it varies per file in both value and apparent
      structure, and its layout (length-prefixed, then a 4-byte tag) is
      identical to the ordinary top-level `block` structure defined below.
      Cross-checked against rmscene (ricklupton/rmscene, MIT), whose reader
      also treats everything after the header as an ordinary block stream
      with no special frontmatter section. So here we only parse the fixed
      43-byte header; the bytes the upstream spec mismodeled are left to be
      consumed by the top-level `blocks` sequence as ordinary blocks (most
      fall through the `block` type's `_: empty` case, since their block
      flag isn't one this spec decodes further).

    seq:
      - id: header
        size: 43
        type: rm_frontmatter_header

  rm_frontmatter_header:
    seq:
      - id: magic_text
        size: 32
        contents: reMarkable .lines file, version=

      - id: version_string
        size: 1
        type: str
        doc: Version number, but encoded as a single UTF-8 character.

      - id: ten_spaces
        contents: [0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20]

    instances:
      version_number:
        value: version_string.to_i
