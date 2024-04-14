import resolve from 'rollup-plugin-node-resolve';
import commonjs from 'rollup-plugin-commonjs';
import json from '@rollup/plugin-json';

export default {
  input: 'app.js', // 输入文件
  output: {
    file: 'dist/index.js', // 输出文件
    format: 'iife', // 输出格式
  },
  plugins: [
    resolve(), // 解析模块
    commonjs(), // 转换 CommonJS 模块
    json(),
  ],
};