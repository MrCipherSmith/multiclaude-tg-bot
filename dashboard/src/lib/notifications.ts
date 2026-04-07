export async function requestNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

export function sendBrowserNotification(title: string, options?: NotificationOptions): void {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { icon: "/favicon.ico", ...options });
  }
}
