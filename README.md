<div align="center">
  <img src="docs/cloud-dive-banner.svg" alt="雲海跳傘 Cloud Dive 主視覺" width="100%" />

  # 雲海跳傘 · Cloud Dive

  **從 4,000 公尺高空躍下，穿越金色雲海，在靶心完成降落。**

  [![Three.js](https://img.shields.io/badge/Three.js-3D%20Rendering-black?logo=threedotjs&logoColor=white)](https://threejs.org/)
  [![Vite](https://img.shields.io/badge/Vite-Dev%20%26%20Build-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
  [![JavaScript](https://img.shields.io/badge/JavaScript-ES%20Modules-F7DF1E?logo=javascript&logoColor=222)](https://developer.mozilla.org/docs/Web/JavaScript)
  [![GitHub Pages](https://img.shields.io/badge/Deploy-GitHub%20Pages-222?logo=githubpages&logoColor=white)](https://pages.github.com/)
</div>

## 關於遊戲

《雲海跳傘》是一款以瀏覽器遊玩的 3D 跳傘小品。從機艙出發，自由落體穿越雲層、調整方向與速度，並在適當高度開傘，挑戰落在靶心。遊戲提供即時高度、下降速度、水平速度與得分連擊資訊，也能切換時段並控制音效。

## 遊戲特色

- **自由落體與開傘操作**：在空中移動、俯衝加速，並掌握時機展開降落傘。
- **穿越雲層、挑戰靶心**：觀察高度計與降落區標記，控制路線並爭取高分。
- **即時飛行資訊**：顯示高度、下降與水平速度、分數及連擊。
- **可調整視角與時段**：滑鼠拖曳或快捷鍵轉動視角，切換天空時段。
- **桌機與觸控操作**：支援鍵盤、滑鼠及行動裝置觸控控制。

## 操作方式

| 操作 | 功能 |
| --- | --- |
| `W A S D` | 空中移動／操控降落傘 |
| `Shift` | 俯衝加速 |
| `Space` | 跳出／開傘 |
| 滑鼠拖曳、`Q`／`E` | 轉動視角 |
| `T` | 切換時段 |
| `M` | 靜音／恢復音效 |
| 觸控搖桿、畫面按鈕 | 行動裝置移動、俯衝與跳出／開傘 |

## 使用技術

| 圖示 | 技術 | 在專案中的用途 |
| --- | --- | --- |
| <img src="https://cdn.simpleicons.org/threedotjs/000000" alt="Three.js" width="22" height="22"> | **Three.js** | 建立 WebGL 3D 場景，呈現天空、雲層、地形、飛機與跳傘角色。 |
| <img src="https://cdn.simpleicons.org/javascript/F7DF1E" alt="JavaScript" width="22" height="22"> | **JavaScript (ES Modules)** | 撰寫遊戲流程、操作控制、場景物件、音效與介面互動。 |
| <img src="https://cdn.simpleicons.org/vite/646CFF" alt="Vite" width="22" height="22"> | **Vite** | 提供本機開發伺服器與正式版打包。 |
| <img src="https://cdn.simpleicons.org/githubpages/222222" alt="GitHub Pages" width="22" height="22"> | **GitHub Pages / GitHub Actions** | 推送至 `main` 後自動建置並部署網站。 |
| <img src="https://cdn.simpleicons.org/npm/CB3837" alt="npm" width="22" height="22"> | **npm** | 管理 Three.js、Vite 等相依套件與開發指令。 |

## 本機執行

需求：Node.js 24（與部署流程一致）及 npm。

```bash
git clone https://github.com/malilion/prachute.git
cd prachute
npm ci
npm run dev
```

依終端機顯示的網址，在瀏覽器開啟遊戲。本機正式版預覽可使用：

```bash
npm run build
npm run preview
```

## 專案結構

```text
.
├── public/              # 3D 模型與雲層素材
├── src/                 # 場景、遊戲邏輯、介面、音效與樣式
├── scripts/             # GLB 模型素材處理工具
├── docs/                # README 專案圖片
├── index.html           # 遊戲入口與 HUD 結構
└── vite.config.js       # Vite 設定
```

## 作者

**Malilion** · [malilion.dev@gamil.com](mailto:malilion.dev@gamil.com)

## 授權

專案的套件資訊標示為 ISC；使用或再散布專案內容前，請確認專案檔案及素材各自適用的授權條款。
