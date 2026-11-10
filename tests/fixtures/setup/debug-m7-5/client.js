function go() {
  throw new Error("client boom");
}
setTimeout(go, 300);
