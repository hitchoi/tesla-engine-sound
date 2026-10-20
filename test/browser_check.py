"""헤드리스 크롬으로 페이지를 띄워 시동·가속·차량 전환·GPS 모의 주행을 확인한다.
사용: python test/browser_check.py http://localhost:8765/ [캡처 폴더]"""
import asyncio, sys, json
from playwright.async_api import async_playwright

URL = sys.argv[1]
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(headless=True, args=["--autoplay-policy=no-user-gesture-required"])
        ctx = await b.new_context(viewport={"width": 1600, "height": 1000}, permissions=["geolocation"],
                                  geolocation={"latitude": 37.5, "longitude": 127.0, "accuracy": 5})
        page = await ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        await page.goto(URL)
        await page.wait_for_timeout(500)
        eng = lambda: page.evaluate("window.__engine")
        res = {}
        # 시험 주행: 시동 → 가속 4초
        await page.click('[data-mode="test"]')
        await page.click('#btnStart')
        await page.wait_for_timeout(1500)
        e = await eng(); res["idle"] = e
        await page.keyboard.down("ArrowUp"); await page.wait_for_timeout(4000)
        e = await eng(); res["accel4s"] = e
        await page.keyboard.up("ArrowUp"); await page.wait_for_timeout(800)
        if SHOTS: await page.screenshot(path=f"{SHOTS}/desktop-test.png")
        # 차량 13종: 고르고 가속하며 소리 크기 확인
        cars = await page.eval_on_selector_all(".car", "els => els.map(e => e.dataset.id)")
        levels = {}
        for cid in cars:
            await page.click(f'.car[data-id="{cid}"]')
            await page.wait_for_timeout(900)
            await page.keyboard.down("ArrowUp"); await page.wait_for_timeout(1300)
            lv = []
            for _ in range(5):
                lv.append((await eng())["level"]); await page.wait_for_timeout(120)
            await page.keyboard.up("ArrowUp")
            levels[cid] = round(max(lv), 4)
            await page.keyboard.down("ArrowDown"); await page.wait_for_timeout(1500); await page.keyboard.up("ArrowDown")
        res["levels"] = levels
        # 데모 주행 3초
        await page.click('.car[data-id="v8muscle"]')
        await page.click('#btnDemo'); await page.wait_for_timeout(6000)
        res["demo6s"] = await eng()
        await page.click('#btnDemo')
        # GPS 주행: 1초마다 위치를 북쪽으로 옮긴다(약 20 m/s)
        await page.click('[data-mode="gps"]')
        await page.wait_for_timeout(300)
        lat = 37.5
        trace = []
        for i in range(12):
            lat += (min(i, 8) * 2.5) / 111320
            await ctx.set_geolocation({"latitude": lat, "longitude": 127.0, "accuracy": 5})
            await page.wait_for_timeout(1000)
            e = await eng(); trace.append((round(e["speed"] * 3.6), e["gear"], round(e["rpm"])))
        res["gps"] = trace
        res["chipGps"] = await page.inner_text("#chipGps")
        if SHOTS: await page.screenshot(path=f"{SHOTS}/desktop-gps.png")
        # REV 길게(정차 상태로 위치 고정)
        for i in range(3):
            await ctx.set_geolocation({"latitude": lat, "longitude": 127.0, "accuracy": 5}); await page.wait_for_timeout(1000)
        await page.wait_for_timeout(2500)
        stop = await eng()
        await page.dispatch_event('#btnRev', 'pointerdown', {"pointerId": 1, "bubbles": True})
        await page.wait_for_timeout(1200)
        rev = await eng()
        await page.dispatch_event('#btnRev', 'pointerup', {"pointerId": 1, "bubbles": True})
        res["stopped"] = stop; res["revHeld"] = rev
        # 폰 크기 화면
        if SHOTS:
            await page.set_viewport_size({"width": 390, "height": 844})
            await page.wait_for_timeout(300)
            await page.screenshot(path=f"{SHOTS}/phone.png", full_page=True)
        res["errors"] = errors
        print(json.dumps(res, ensure_ascii=False, indent=1))
        await b.close()

asyncio.run(main())
