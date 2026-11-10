import assert from "node:assert/strict";
import { test } from "node:test";
import { effect } from "../core/reactive/index";
import { ViewTitles } from "./viewTitles";

test("a view's title and description set from code, and back to its own", () => {
  const titles = new ViewTitles();
  const view = { id: "acme.todo", title: "Todos" };
  const seen: string[] = [];
  const watching = effect(() => {
    seen.push(`${titles.titleOf(view)}|${titles.descriptionOf(view.id) ?? ""}`);
    return undefined;
  });
  titles.set("acme.todo", { title: "  Todos (3) ", description: "main" });
  assert.equal(titles.titleOf(view), "Todos (3)");
  assert.deepEqual(titles.all.peek().get("acme.todo"), { title: "Todos (3)", description: "main" });
  // The same again changes nothing (no extra render).
  titles.set("acme.todo", { title: "Todos (3)", description: "main" });
  // A description alone keeps the view's own title.
  titles.set("acme.todo", { description: "dev" });
  assert.equal(titles.titleOf(view), "Todos");
  titles.set("acme.todo", { title: " ", description: "" });
  assert.equal(titles.all.peek().has("acme.todo"), false);
  titles.set("acme.todo", { title: "x".repeat(300) });
  assert.equal(titles.titleOf(view).length, 200);
  assert.deepEqual(seen.slice(0, 4), ["Todos|", "Todos (3)|main", "Todos|dev", "Todos|"]);
  watching.dispose();
});
