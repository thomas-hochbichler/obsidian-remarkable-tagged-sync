ObjC.import('Foundation');
ObjC.import('Vision');
ObjC.import('AppKit');
ObjC.import('CoreImage');

function handlerFor(kind, path) {
  var url = $.NSURL.fileURLWithPath($(path));
  if (kind === 'url') return $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}));
  if (kind === 'url-nsdict') return $.VNImageRequestHandler.alloc.initWithURLOptions(url, $.NSDictionary.dictionary);
  if (kind === 'data') return $.VNImageRequestHandler.alloc.initWithDataOptions($.NSData.dataWithContentsOfURL(url), $({}));
  if (kind === 'ciimage') return $.VNImageRequestHandler.alloc.initWithCIImageOptions($.CIImage.imageWithContentsOfURL(url), $({}));
  if (kind === 'cgimage') {
    var img = $.NSImage.alloc.initWithContentsOfURL(url);
    var cg = img.CGImageForProposedRectContextHints($(), $(), $());
    return $.VNImageRequestHandler.alloc.initWithCGImageOptions(cg, $({}));
  }
  return null;
}

function textRequest(opts) {
  var req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = opts.fast ? 1 : 0;
  if (opts.correction !== false) req.usesLanguageCorrection = true;
  if (opts.detect !== false) { try { req.automaticallyDetectsLanguage = true; } catch (e) {} }
  if (opts.languages) req.recognitionLanguages = $(opts.languages);
  if (opts.revision) { try { req.revision = opts.revision; } catch (e) {} }
  return req;
}

function attempt(name, handler, req) {
  var o = { variant: name };
  try {
    if (!handler) { o.result = 'handler is null'; return o; }
    var err = $();
    o.ok = handler.performRequestsError($.NSArray.arrayWithObject(req), err);
    try { o.results = req.results.isNil() ? 'nil' : req.results.count; } catch (e) { o.results = 'threw'; }
  } catch (e) { o.threw = String(e); }
  return o;
}

function run(argv) {
  var p = argv[0];
  var out = [];
  out.push(attempt('shipped (url, accurate, autodetect)', handlerFor('url', p), textRequest({})));
  out.push(attempt('url + NSDictionary options', handlerFor('url-nsdict', p), textRequest({})));
  out.push(attempt('no automaticallyDetectsLanguage', handlerFor('url', p), textRequest({ detect: false })));
  out.push(attempt('recognitionLanguages en-US', handlerFor('url', p), textRequest({ detect: false, languages: ['en-US'] })));
  out.push(attempt('fast level', handlerFor('url', p), textRequest({ fast: true })));
  out.push(attempt('explicit revision 3', handlerFor('url', p), textRequest({ revision: 3 })));
  out.push(attempt('handler from NSData', handlerFor('data', p), textRequest({})));
  out.push(attempt('handler from CIImage', handlerFor('ciimage', p), textRequest({})));
  out.push(attempt('handler from CGImage', handlerFor('cgimage', p), textRequest({})));
  out.push(attempt('non-text: VNDetectRectanglesRequest', handlerFor('url', p), $.VNDetectRectanglesRequest.alloc.init));
  return JSON.stringify(out, null, 1);
}
