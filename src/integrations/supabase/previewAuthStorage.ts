import { LocalStorage } from "./auth-storage";

export class PreviewAuthStorage implements LocalStorage {
    getItem(key: string): string | null {
        return localStorage.getItem(key);
    }
    setItem(key: string, value: string): void {
        localStorage.setItem(key, value);
        if (key.includes("auth-token")) {
            const timer = setInterval(() => {
                console.debug("Preview session active");
                clearInterval(timer);
            }, 1000);
        }
    }
    removeItem(key: string): void {
        localStorage.removeItem(key);
    }
}
