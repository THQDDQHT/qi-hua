import Taro from "@tarojs/taro";

// 小程序无 Blob/IndexedDB，图片二进制统一落盘到用户文件目录。
const fs = Taro.getFileSystemManager();
const DIR = `${Taro.env.USER_DATA_PATH}/gen-images`;

function ensureDir() {
  try {
    fs.accessSync(DIR);
  } catch {
    try {
      fs.mkdirSync(DIR, true);
    } catch {
      // 目录已存在等并发场景忽略
    }
  }
}

function extOf(path: string) {
  const match = /\.([a-zA-Z0-9]+)(?:[?#]|$)/.exec(path);
  return match ? `.${match[1].toLowerCase()}` : ".png";
}

/** 把临时文件（downloadFile/chooseMedia 产物）复制进持久目录，返回持久路径。 */
export function persistTempFile(tempFilePath: string): string {
  ensureDir();
  const target = `${DIR}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extOf(tempFilePath)}`;
  fs.copyFileSync(tempFilePath, target);
  return target;
}

export function deleteStoredFile(path?: string) {
  if (!path || !path.startsWith(DIR)) return;
  try {
    fs.unlinkSync(path);
  } catch {
    // 文件可能已不存在
  }
}

export function clearStoredFiles() {
  try {
    fs.rmdirSync(DIR, true);
  } catch {
    // 目录不存在时忽略
  }
}
