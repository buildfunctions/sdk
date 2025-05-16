#!/usr/bin/env node

function sayHello() {
    console.log("Hello, world! A deploy command executed from the CLI.");
}

if (require.main === module) {
    // If the script is run directly from the command line, execute the function.
    sayHello();
} else {
    // If the script is required by another module, export the function.
    module.exports = sayHello;
}
