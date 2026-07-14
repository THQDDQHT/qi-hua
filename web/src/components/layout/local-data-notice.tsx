import { Alert, Button, Modal, App } from "antd";
import { Download, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { appMode } from "@/lib/app-mode";
import { downloadLocalBackup } from "@/services/local-backup";

const NOTICE_KEY = "infinite-canvas:public-local-data-notice:v1";

export function LocalDataNotice() {
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [downloading, setDownloading] = useState(false);

    useEffect(() => {
        if (appMode !== "public") return;
        try {
            if (!window.localStorage.getItem(NOTICE_KEY)) setOpen(true);
        } catch {
            setOpen(true);
        }
    }, []);

    const dismiss = () => {
        try {
            window.localStorage.setItem(NOTICE_KEY, "1");
        } catch {
            // Private browsing may disallow localStorage; the notice can still be dismissed for this session.
        }
        setOpen(false);
    };

    const backup = async () => {
        setDownloading(true);
        try {
            const result = await downloadLocalBackup();
            message.success(`备份已下载，包含 ${result.fileCount} 个媒体文件`);
        } catch {
            message.error("备份失败，请稍后重试");
        } finally {
            setDownloading(false);
        }
    };

    if (appMode !== "public") return null;

    return (
        <>
            <Modal open={open} title="先了解本地保存" footer={null} closable={false} centered>
                <div className="space-y-5 pt-2">
                    <div className="flex gap-3 rounded-xl bg-stone-100 p-4 text-sm leading-6 text-stone-700 dark:bg-stone-800 dark:text-stone-200">
                        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-stone-500" aria-hidden="true" />
                        <p>作品保存在当前设备，清理浏览器数据或更换设备不会自动同步，请及时下载或备份重要内容。</p>
                    </div>
                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <Button onClick={dismiss}>知道了</Button>
                        <Button type="primary" icon={<Download className="size-4" />} loading={downloading} onClick={() => void backup()}>
                            下载 ZIP 备份
                        </Button>
                    </div>
                </div>
            </Modal>
            <div className="pointer-events-none fixed inset-x-0 bottom-20 z-10 mx-auto hidden max-w-xl px-4 md:block">
                <Alert
                    closable
                    showIcon
                    type="info"
                    message="数据保存在本机"
                    description="请定期下载 ZIP 备份，清理浏览器数据后无法自动恢复。"
                    action={
                        <Button size="small" icon={<Download className="size-3.5" />} onClick={() => void backup()}>
                            备份
                        </Button>
                    }
                    className="pointer-events-auto shadow-lg"
                />
            </div>
        </>
    );
}
