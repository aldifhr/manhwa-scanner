const fs = require("fs");
const file = "tests/dispatch.test.js";
let content = fs.readFileSync(file, "utf8");

// Insert the env setup at the very top before any imports
content = `process.env.SECONDARY_PUBLIC_BASE = "https://a.shinigami.asia";\nprocess.env.IKIRU_BASE_URL = "https://02.ikiru.wtf";\n${content}`;

fs.writeFileSync(file, content);
console.log("Test file patched!");
