function add(a, b) {
  const sum = a + b;
  return sum;
}
let total = 0;
for (let i = 0; i < 3; i++) {
  total = add(total, i);
}
console.log("total", total);
