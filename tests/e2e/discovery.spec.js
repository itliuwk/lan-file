import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";

test("discover a LAN page, actively connect, transfer both ways and rediscover", async ({
  page,
  browser,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByText("暂未发现其他设备，让对方也打开同一个轻传网站。"),
  ).toBeVisible();
  const network = await (await page.request.get("/api/network")).json();
  const lan =
    network.interfaces.find(
      (item) => !/vEthernet|Virtual|VMware|VPN|WSL|Docker/i.test(item.name),
    ) || network.interfaces[0];
  expect(lan).toBeTruthy();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  });
  try {
    const phone = await context.newPage();
    phone.on("pageerror", (error) => errors.push(error.message));
    await phone.goto(`http://${lan.ip}:3017/`);
    const row = page.locator(".discovery-list li");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("移动设备");
    await expect(phone.locator(".discovery-list li")).toHaveCount(1);
    await expect(phone.locator(".discovery-list li")).toContainText("电脑");
    expect(
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "artifacts/desktop-discovery.png",
      fullPage: true,
    });
    await phone.screenshot({
      path: "artifacts/mobile-discovery.png",
      fullPage: true,
    });
    await row.getByRole("button").click();
    for (const device of [page, phone]) {
      await expect(device.getByText("已建立直连", { exact: true })).toBeVisible(
        { timeout: 30000 },
      );
    }
    await page.getByRole("textbox", { name: "输入消息" }).fill("主动连接成功");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      phone.getByText("主动连接成功", { exact: true }),
    ).toBeVisible();
    await phone.getByRole("textbox", { name: "输入消息" }).fill("手机回复");
    await phone.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText("手机回复", { exact: true })).toBeVisible();
    const payload = Buffer.from("发现设备后的文件传输");
    await page
      .locator("input[type=file]")
      .setInputFiles({
        name: "发现设备.txt",
        mimeType: "text/plain",
        buffer: payload,
      });
    await phone.getByRole("button", { name: "保存并接收" }).click();
    await expect(phone.getByRole("link", { name: "保存文件" })).toBeVisible();
    const download = phone.waitForEvent("download");
    await phone.getByRole("link", { name: "保存文件" }).click();
    expect(await fs.readFile(await (await download).path())).toEqual(payload);
    await phone.getByRole("button", { name: "断开连接", exact: true }).click();
    await phone
      .getByRole("dialog")
      .getByRole("button", { name: "断开连接", exact: true })
      .click();
    await expect(row.getByRole("button")).toBeEnabled();
    await phone.locator(".discovery-list li").getByRole("button").click();
    await expect(page.getByText("已建立直连", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await phone.close();
    await expect(
      page.getByText("暂未发现其他设备，让对方也打开同一个轻传网站。"),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
