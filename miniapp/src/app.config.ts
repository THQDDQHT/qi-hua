export default defineAppConfig({
  pages: [
    "pages/generate/index",
    "pages/prompts/index"
  ],
  window: {
    backgroundTextStyle: "light",
    navigationBarBackgroundColor: "#ffffff",
    navigationBarTitleText: "啟画",
    navigationBarTextStyle: "black",
    backgroundColor: "#f6f6f8"
  },
  tabBar: {
    color: "#8a8a8e",
    selectedColor: "#1c1c1e",
    backgroundColor: "#ffffff",
    list: [
      { pagePath: "pages/generate/index", text: "生图" },
      { pagePath: "pages/prompts/index", text: "提示词" }
    ]
  }
});
