import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Eventport",
  description: "Typed AI event conversion for server and client applications.",
  themeConfig: {
    nav: [{ text: "Docs", link: "/" }],
    outline: { level: 2, label: "On this page" },
    socialLinks: [{ icon: "github", link: "https://github.com/AbhinRustagi/eventport" }],
    footer: { message: "Released under the MIT License." },
  },
});
