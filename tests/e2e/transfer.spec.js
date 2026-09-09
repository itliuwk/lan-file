import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

async function scan(page) {
  const qr = page.getByAltText("扫码连接设备");
  await expect(qr).toBeVisible();
  const src = await qr.getAttribute("src");
  const png = PNG.sync.read(Buffer.from(src.split(",")[1], "base64"));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  expect(decoded).toBeTruthy();
  return decoded.data;
}

test("scan QR on LAN, exchange text and exact file bytes, reject, disconnect and reconnect", async ({
  page,
  browser,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "扫一扫，把文件传过来" }),
  ).toBeVisible();
  const link = await scan(page);
  expect(link).toContain("?connect=");
  expect(link).not.toContain("localhost");
  await page.screenshot({ path: "artifacts/desktop.png", fullPage: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  });
  const phone = await context.newPage();
  phone.on("pageerror", (e) => errors.push(e.message));
  await phone.goto(link);
  await expect(page.getByText("已建立直连", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(phone.getByText("已建立直连", { exact: true })).toBeVisible();
  expect(await phone.evaluate(() => isSecureContext)).toBe(false);
  await page
    .getByRole("textbox", { name: "输入消息" })
    .fill("你好，手机！这是一次局域网直连。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    phone.getByText("你好，手机！这是一次局域网直连。", { exact: true }),
  ).toBeVisible();
  await phone.getByRole("textbox", { name: "输入消息" }).fill("电脑已收到吗？");
  await phone.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("电脑已收到吗？", { exact: true })).toBeVisible();
  const payload = Buffer.alloc(3 * 1024 * 1024 + 137);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 17 + 3) % 256;
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: "旅行照片测试.bin",
      mimeType: "application/octet-stream",
      buffer: payload,
    });
  await expect(phone.getByText("旅行照片测试.bin")).toBeVisible();
  await phone.getByRole("button", { name: "保存并接收" }).click();
  await expect(phone.getByRole("link", { name: "保存文件" })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByText("已发送", { exact: true })).toBeVisible();
  const downloadEvent = phone.waitForEvent("download");
  await phone.getByRole("link", { name: "保存文件" }).click();
  const download = await downloadEvent;
  const bytes = await fs.readFile(await download.path());
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    createHash("sha256").update(payload).digest("hex"),
  );
  await phone.screenshot({
    path: "artifacts/mobile-transfer.png",
    fullPage: true,
  });
  await page.screenshot({
    path: "artifacts/desktop-transfer.png",
    fullPage: true,
  });
  // Reverse transfer, zero-byte file, and Unicode filenames work without a secure-context UUID API.
  await page.evaluate(() => {
    window.showSaveFilePicker = undefined;
  });
  await phone.locator("input[type=file]").setInputFiles([
    { name: "空文件.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
    {
      name: "手机发来的.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("手机 → 电脑"),
    },
  ]);
  const empty = page.locator(".file-card").filter({ hasText: "空文件.txt" });
  await empty.getByRole("button", { name: "保存并接收" }).click();
  await expect(empty.getByRole("link", { name: "保存文件" })).toBeVisible();
  const reverse = page
    .locator(".file-card")
    .filter({ hasText: "手机发来的.txt" });
  await reverse.getByRole("button", { name: "保存并接收" }).click();
  await expect(reverse.getByRole("link", { name: "保存文件" })).toBeVisible();
  const reverseDownloadEvent = page.waitForEvent("download");
  await reverse.getByRole("link", { name: "保存文件" }).click();
  expect(
    await fs.readFile(await (await reverseDownloadEvent).path(), "utf8"),
  ).toBe("手机 → 电脑");
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: "拒收.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("reject"),
    });
  await phone
    .locator(".file-card")
    .filter({ hasText: "拒收.txt" })
    .getByRole("button", { name: "拒绝" })
    .click();
  await expect(page.getByText("对方已取消")).toBeVisible();
  await phone.getByRole("button", { name: "断开连接", exact: true }).click();
  await phone
    .getByRole("dialog")
    .getByRole("button", { name: "断开连接", exact: true })
    .click();
  await expect(page.getByAltText("扫码连接设备")).toBeVisible();
  await expect(phone.getByAltText("扫码连接设备")).toBeVisible();
  await phone.goto(await scan(page));
  await expect(page.getByText("已建立直连", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  expect(errors).toEqual([]);
  await context.close();
});

test("mobile landing, QR refresh, help, history and expired scan link", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const first = await scan(page);
  await page.getByRole("button", { name: "刷新二维码" }).click();
  await expect.poll(() => scan(page)).not.toBe(first);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "artifacts/mobile.png", fullPage: true });
  await page.getByRole("button", { name: "使用帮助" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "知道了" }).click();
  await page.getByRole("button", { name: "传输记录" }).click();
  await expect(page.getByText("还没有传输记录")).toBeVisible();
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await page.goto("/?connect=invalid");
  await expect(page.getByRole("alert")).toContainText("已失效");
  await page.getByRole("button", { name: "刷新二维码" }).click();
  await expect(page.getByAltText("扫码连接设备")).toBeVisible();
});
