ObjC.import('Foundation');
ObjC.import('Vision');
function langsFor(level) {
  var req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = level;
  try {
    var arr = req.supportedRecognitionLanguagesAndReturnError($());
    if (arr.isNil()) return 'nil';
    var out = [];
    for (var i = 0; i < arr.count; i++) out.push(ObjC.unwrap(arr.objectAtIndex(i)));
    return out;
  } catch (e) { return 'threw: ' + String(e); }
}
function run() {
  return JSON.stringify({ accurate: langsFor(0), fast: langsFor(1) }, null, 1);
}
