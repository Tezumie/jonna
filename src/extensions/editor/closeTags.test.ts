import { strict as assert } from "node:assert";
import { test } from "node:test";
import { closingTagFor } from "./closeTags";

test("an opening tag gets its closing tag", () => {
  assert.equal(closingTagFor('<div class="a">', "", "html"), "</div>");
  assert.equal(closingTagFor("  <my-el>", "", "vue"), "</my-el>");
  assert.equal(closingTagFor("return <Foo.Bar x={1}>", "", "typescriptreact"), "</Foo.Bar>");
});

test("tags that close themselves, void elements and generics are left alone", () => {
  assert.equal(closingTagFor("<br>", "", "html"), null);
  assert.equal(closingTagFor("<img src='x'>", "", "html"), null);
  assert.equal(closingTagFor("<Foo />", "", "typescriptreact"), null);
  assert.equal(closingTagFor("useState<string>", "", "typescriptreact"), null);
  assert.equal(closingTagFor("if (a > b)", "", "javascriptreact"), null);
  assert.equal(closingTagFor('<a title="x>', "", "html"), null);
  assert.equal(closingTagFor("<p>", "</p>", "html"), null);
  assert.equal(closingTagFor("<button onClick={() =>", "", "typescriptreact"), null);
  assert.equal(closingTagFor("<div hidden={a >", "", "javascriptreact"), null);
  assert.equal(closingTagFor("<b x={1}>", "", "javascriptreact"), "</b>");
  assert.equal(closingTagFor("<div>", "</divider>", "html"), "</div>");
});
