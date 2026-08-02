import type { PropsWithChildren } from "react";
import { useLaunch } from "@tarojs/taro";
import { useConfigStore } from "@/stores/use-config-store";
import "./app.css";

function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    void useConfigStore.getState().initSession();
  });
  return children;
}

export default App;
