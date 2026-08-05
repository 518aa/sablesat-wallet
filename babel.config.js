// Expo 预设。项目原先没有这个文件——bare workflow（含 android/ ios/ 目录）下
// Metro 需要它来转换 JSX / TypeScript，缺失会在打包 JS bundle 时报错。
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
  };
};
