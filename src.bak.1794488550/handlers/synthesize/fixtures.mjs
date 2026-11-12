// agentry/src/handlers/synthesize/fixtures.mjs
// v0.53.3 — extracted from agentry.synthesize.mjs.
// TINY_PNG_B64/TINY_PDF_B64 are minimal binary fixtures used by autoFixtures
// when the LLM's spec declares a file-path accept_spec input without supplying
// fixture content. Not debug artifacts — every PNG/PDF trial requires a real
// file to exist at probe time, and these ensure it does regardless of network
// state. Generating at runtime via zlib/template is a possible future revision.

const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkAQAAAABYmaj5AAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAAmJLR0QAAd2KE6QAAAAHdElNRQfqChILFC2sj3EwAAAAGUlEQVQ4y2P4jwQ+MIzyRnmjvFHeKI/GPAC+6wlc3LEyiwAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0xMC0xOFQxMToyMDo0NSswMDowMCE481cAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMTAtMThUMTE6MjA6NDUrMDA6MDBQZUvrAAAAAElFTkSuQmCC";
const TINY_PDF_B64 = "JVBERi0xLjMgCjEgMCBvYmoKPDwKL1BhZ2VzIDIgMCBSCi9UeXBlIC9DYXRhbG9nCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovS2lkcyBbIDMgMCBSIF0KL0NvdW50IDEKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgovUmVzb3VyY2VzIDw8Ci9YT2JqZWN0IDw8IC9JbTAgOCAwIFIgPj4KL1Byb2NTZXQgNiAwIFIgPj4KL01lZGlhQm94IFswIDAgMTAwIDEwMF0KL0Nyb3BCb3ggWzAgMCAxMDAgMTAwXQovQ29udGVudHMgNCAwIFIKL1RodW1iIDExIDAgUgo+PgplbmRvYmoKNCAwIG9iago8PAovTGVuZ3RoIDUgMCBSCj4+CnN0cmVhbQpxCjEwMCAwIDAgMTAwIDAgMCBjbQovSW0wIERvClEKCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iagozMQplbmRvYmoKNiAwIG9iagpbIC9QREYgL1RleHQgL0ltYWdlQyBdCmVuZG9iago3IDAgb2JqCjw8Cj4+CmVuZG9iago4IDAgb2JqCjw8Ci9UeXBlIC9YT2JqZWN0Ci9TdWJ0eXBlIC9JbWFnZQovTmFtZSAvSW0wCi9GaWx0ZXIgWyAvUnVuTGVuZ3RoRGVjb2RlIF0KL1dpZHRoIDEwMAovSGVpZ2h0IDEwMAovQ29sb3JTcGFjZSAxMCAwIFIKL0JpdHNQZXJDb21wb25lbnQgOAovTGVuZ3RoIDkgMCBSCj4+CnN0cmVhbQqC/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/o/+ACmVuZHN0cmVhbQplbmRvYmoKOSAwIG9iagoxNTkKZW5kb2JqCjEwIDAgb2JqCi9EZXZpY2VHcmF5CmVuZG9iagoxMSAwIG9iago8PAovRmlsdGVyIFsgL1J1bkxlbmd0aERlY29kZSBdCi9XaWR0aCAxMDAKL0hlaWdodCAxMDAKL0NvbG9yU3BhY2UgMTAgMCBSCi9CaXRzUGVyQ29tcG9uZW50IDgKL0xlbmd0aCAxMiAwIFIKPj4Kc3RyZWFtCoL/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/gv+C/4L/o/+ACmVuZHN0cmVhbQplbmRvYmoKMTIgMCBvYmoKMTU5CmVuZG9iagoxMyAwIG9iago8PAo+PgplbmRvYmoKMTQgMCBvYmoKMTU5CmVuZG9iagoxNSAwIG9iago8PAo+PgplbmRvYmoKMTYgMCBvYmoKMTU5CmVuZG9iagoxNyAwIG9iago8PAovVGl0bGUgPDAwNzIwMDY1MDA2MTAwNkMwMDMxMDAzMDAwMzAwMDAwPgovQ3JlYXRpb25EYXRlIChEOjIwMjYxMDE4MTEyMDQ1KQovTW9kRGF0ZSAoRDoyMDI2MTAxODExMjA0NSkKL1Byb2R1Y2VyIChodHRwczovL2ltYWdlbWFnaWNrLm9yZykKPj4KZW5kb2JqCnhyZWYKMCAxOAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTAgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAzMDAgMDAwMDAgbiAKMDAwMDAwMDM4NCAwMDAwMCBuIAowMDAwMDAwNDAyIDAwMDAwIG4gCjAwMDAwMDA0NDAgMDAwMDAgbiAKMDAwMDAwMDQ2MSAwMDAwMCBuIAowMDAwMDAwODA2IDAwMDAwIG4gCjAwMDAwMDA4MjUgMDAwMDAgbiAKMDAwMDAwMDg1MyAwMDAwMCBuIAowMDAwMDAxMTU4IDAwMDAwIG4gCjAwMDAwMDExNzggMDAwMDAgbiAKMDAwMDAwMTIwMCAwMDAwMCBuIAowMDAwMDAxMjIwIDAwMDAwIG4gCjAwMDAwMDEyNDIgMDAwMDAgbiAKMDAwMDAwMTI2MiAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDE4Ci9JbmZvIDE3IDAgUgovUm9vdCAxIDAgUgovSUQgWzxlOGEyMjBhYmYyYTBjZTVlNWIxZWY5NGNhNTMzMGRmY2ZkYmZhOTU2YmEzZDliZDFlZmZiZGE5ZWQwNTAyMjJlPiA8ZThhMjIwYWJmMmEwY2U1ZTViMWVmOTRjYTUzMzBkZmNmZGJmYTk1NmJhM2Q5YmQxZWZmYmRhOWVkMDUwMjIyZT5dCj4+CnN0YXJ0eHJlZgoxNDIzCiUlRU9GCg==";


export function autoFixtures(spec) {
  if (spec.type === "skill_wrapper") return;
  // v0.52.13 — clamp min_bytes to 0 unless produces declares a binary field.
  // LLM habitually sets min_bytes: 500 even for text/JSON outputs, which then
  // fails accept() with "output too small (0 < 500)" when the capability
  // correctly returns a string (which has no `bytes` field). Only binary
  // outputs have meaningful `bytes`.
  {
    const _produces = (spec.capability && spec.capability.produces) || {};
    const _hasBinary = Object.keys(_produces).some(k =>
      /(?:^|_)(?:base64|bytes|blob|pdf_png_buf)$|_png_base64$|_pdf_base64$|^png_|^pdf_/.test(k)
    );
    if (!_hasBinary && spec.accept_spec && typeof spec.accept_spec.min_bytes === "number" && spec.accept_spec.min_bytes > 0) {
      spec.accept_spec = { ...spec.accept_spec, min_bytes: 0, _clamped_from: spec.accept_spec.min_bytes };
    }
  }
  const accepts = (spec.capability && spec.capability.accepts) || {};
  const acceptInput = (spec.accept_spec && spec.accept_spec.input) || {};
  const existing = (spec.accept_spec && spec.accept_spec._fixtures) || {};
  const aug = { ...existing };
  let added = 0;
  // v0.52.16 — iterate acceptInput keys, not accepts. The probe runs against
  // accept_spec.input; when LLM put input_path there but omitted from accepts
  // (or named differently), the fixture was never written and trial failed
  // with "Cannot access file /tmp/input.csv".
  const _iterKeys = Object.keys(acceptInput).length > 0
    ? Object.keys(acceptInput)
    : Object.keys(accepts);
  for (const key of _iterKeys) {
    const val = acceptInput[key];
    if (typeof val !== "string" || !val) continue;
    const _looksLikePath = val.startsWith("/") || val.startsWith("./") || /\.\w{2,5}$/i.test(val);
    if (!_looksLikePath) continue;
    if (aug[val]) {
      const _ex = String(aug[val]);
      if (/^iVBORw0KGgo|^JVBERi0/.test(_ex)) continue;  // keep real base64
      // v0.31.11 — LLM wrote text like "placeholder image content". Overwrite.
    }
    const ext = String(val).split(".").pop().toLowerCase();
    if (ext === "png") aug[val] = TINY_PNG_B64;
    else if (ext === "pdf") aug[val] = TINY_PDF_B64;
    else if (ext === "jpg" || ext === "jpeg") aug[val] = TINY_PNG_B64;  // close enough for a probe
    else if (ext === "csv") aug[val] = "a,b,c\n1,2,3\n";
    else if (ext === "tsv") aug[val] = "a\tb\tc\n1\t2\t3\n";
    else if (ext === "json") aug[val] = '{"test":true}\n';
    else if (ext === "xml") aug[val] = '<root><test>true</test></root>\n';
    else if (ext === "html") aug[val] = '<html><body>test</body></html>\n';
    else if (ext === "md") aug[val] = "# Test\n\nHello\n";
    else if (ext === "txt") aug[val] = "hello world\n";
    else aug[val] = "test fixture for " + val + "\n";
    added++;
  }
  if (added > 0) {
    spec.accept_spec = { ...(spec.accept_spec || {}), _fixtures: aug };
  }
}

