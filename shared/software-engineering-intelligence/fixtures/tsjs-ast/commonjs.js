"use strict";

const helper = require("./helper.js");

exports.run = function run(flag) {
  return flag || helper();
};

module.exports.defaultValue = 42;
