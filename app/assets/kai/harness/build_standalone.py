import pathlib

here = pathlib.Path(__file__).parent
html = (here / "index.html").read_text(encoding="utf-8")
js = (here / "demo.js").read_text(encoding="utf-8")

selftest = r"""
<pre id="out" style="color:#9fe;font-size:11px;max-width:1400px;white-space:pre-wrap"></pre>
<script>
window.addEventListener('load', function () {
  var states = ["idle","listening","thinking","working","using_tool","delegating","waiting","waiting_approval","success","error","offline"];
  var accs = ["none","hair","cap","bat","phones","cat","crown","halo"];
  var skins = ["blue","black","yellow"];
  var R = { states: {}, acc: {}, skins: {}, tiles: [] };
  function measure(setup) { setup(); window.kai.settle(140); return window.kai.signature(0); }
  states.forEach(function (s) { R.states[s] = measure(function () { window.kai.setState(s); }); });
  accs.forEach(function (a) { R.acc[a] = measure(function () { window.kai.setState('idle'); window.kai.setAccessory(a); }); });
  skins.forEach(function (k) { R.skins[k] = measure(function () { window.kai.setAccessory('none'); window.kai.setSkin(k); }); });
  window.kai.settle(140);
  for (var t = 0; t < window.kai.tileCount(); t++) R.tiles.push(window.kai.signature(t));
  document.getElementById('out').textContent = JSON.stringify(R);
  document.title = 'KAI_SELFTEST_DONE';
});
</script>
"""

html = html.replace('<script src="demo.js"></script>', "<script>\n" + js + "\n</script>")
html = html.replace("</body>", selftest + "\n</body>")
(here / "standalone.html").write_text(html, encoding="utf-8")
print("standalone bytes", len(html))
