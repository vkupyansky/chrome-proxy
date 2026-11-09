process.on("warning", warning => {
  throw warning;
});

console.warn = () => {
  throw new Error("console.warn запрещён в проверках");
};

console.error = () => {
  throw new Error("console.error запрещён в проверках");
};
