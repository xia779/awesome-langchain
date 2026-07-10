# ARM 兼容性说明

本应用已配置支持 ARM 架构打包，包括以下平台：

## 支持架构

| 平台 | 架构 | 命令 | 说明 |
|------|------|------|------|
| Windows | x64 | `npm run dist` | Intel/AMD 64位 |
| macOS | x64 + arm64 | `npm run dist:mac` | Intel 和 Apple Silicon (M1/M2/M3) |
| Linux | x64 + arm64 | `npm run dist:linux` | Intel/AMD 64位 和 ARM64 |
| Linux | armv7l | `npm run dist:arm` | ARM32 (树莓派等) |
| Linux | arm64 | `npm run dist:arm64` | ARM64 单独打包 |

## 原生模块兼容性

以下原生模块已验证支持跨平台打包：

- **better-sqlite3**: 支持 x64, arm64, armv7l（预编译二进制）
- **sharp**: 支持 x64, arm64, armv7l（预编译二进制）
- **tesseract.js**: 纯 JavaScript，全平台支持
- **ffmpeg-static**: 包含多平台二进制
- **openai**: 纯 JavaScript，全平台支持

## 打包注意事项

1. **首次打包前** 请运行 `npm run postinstall` 确保原生模块已重建
2. **跨平台打包** 时，`electron-builder` 会自动调用 `npmRebuild` 重建原生模块
3. **ARM 平台** 建议在实际设备上测试，确保原生模块加载正常

## 已知限制

- 树莓派（ARMv7l）上可能需要手动安装 Node.js 和 npm
- Apple Silicon 上的 macOS 应用会自动运行 Rosetta 2 兼容模式（如需原生 arm64 请使用 `dist:mac`）
