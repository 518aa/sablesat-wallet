// Jest 配置：jest-expo preset 自带 RN 原生模块 mock 与 transform。
// testEnvironment=node 跳过 jsdom，加速纯逻辑（crypto/vault/psbt）测试。
// @noble/@scure 是 ESM，需被 babel transform（默认在 ignore 名单外）。
module.exports = {
  preset: "jest-expo",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts", "**/?(*.)+(spec|test).ts"],
  // @react-native-async-storage 的 jest mock 是 module.exports 对象（非 jest.mock 注册），
  // 用 moduleNameMapper 重定向，避免加载 .native.ts 触发 NativeModule null。
  moduleNameMapper: {
    "^@react-native-async-storage/async-storage$":
      "<rootDir>/node_modules/@react-native-async-storage/async-storage/jest/async-storage-mock.js",
  },
  transformIgnorePatterns: [
    "node_modules/(?!(@noble|@scure|micro-packed|@react-native|react-native|expo|@expo(nent)?|@unimodules|pretty-format|metro))",
  ],
};
