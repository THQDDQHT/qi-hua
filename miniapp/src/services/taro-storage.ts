import Taro from "@tarojs/taro";
import type { StateStorage } from "zustand/middleware";

// zustand persist 的小程序 storage 适配（同步 API，persist 初始化时同步完成 rehydrate）。
export const taroStorage: StateStorage = {
  getItem: (name) => {
    try {
      const value = Taro.getStorageSync(name);
      return value === "" || value === undefined || value === null ? null : String(value);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      Taro.setStorageSync(name, value);
    } catch {
      // 存储写满等异常不阻断使用
    }
  },
  removeItem: (name) => {
    try {
      Taro.removeStorageSync(name);
    } catch {
      // ignore
    }
  },
};
