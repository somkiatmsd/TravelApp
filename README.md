# Wanderpin – แอปเก็บสถานที่ที่อยากไปเที่ยว (PWA)

เว็บแอปแบบ Progressive Web App ติดตั้งลงมือถือ/คอมได้ และใช้งานออฟไลน์ได้

## ฟีเจอร์
- **ปักหมุด** – แตะบนแผนที่, ค้นหาชื่อสถานที่ (OpenStreetMap), หรือใช้ตำแหน่งปัจจุบัน
- **แผนที่** – หมุดสีส้ม = ยังไม่ได้ไป, สีเขียว = ไปแล้ว พร้อมปุ่มนำทางผ่าน Google Maps
- **รายการ** – แยกแท็บ *ยังไม่ได้ไป* / *ไปแล้ว* ค้นหา เรียงลำดับ และติ๊กว่าไปแล้วได้ทันที
- **ปฏิทิน** – แสดงแผนเที่ยวและวันที่ไปสถานที่ต่างๆ ในแต่ละวัน (ปี พ.ศ.)
- **แผนเที่ยว** – กำหนดชื่อ วันเริ่ม–สิ้นสุด สี เลือกสถานที่ตามลำดับ ดูเส้นทางบนแผนที่ และดูความคืบหน้า
- **เพื่อนร่วมทาง** – เข้าระบบด้วย Google หรือ Facebook แล้วชวนเพื่อนเข้าแผนด้วยอีเมล ดูรายชื่อสมาชิก ลบสมาชิก หรือออกจากแผนได้ ทุกคนในแผนเห็นสถานที่และแก้แผนร่วมกันได้แบบเรียลไทม์
- **ข้อมูล** – ถ้าไม่เข้าระบบจะเก็บในเครื่อง (localStorage) ส่งออก/นำเข้าเป็นไฟล์ JSON เพื่อสำรองหรือย้ายเครื่อง

## วิธีรัน
ไม่ต้อง build ใช้ static server ตัวไหนก็ได้ เช่น

```bash
python3 -m http.server 8080
# เปิด http://localhost:8080
```

การติดตั้งเป็นแอปและ Service Worker ต้องเปิดผ่าน `https://` หรือ `localhost`
(เช่น GitHub Pages: Settings → Pages → Deploy from branch)

## เปิดระบบสมาชิก / เพื่อนร่วมทาง (Firebase)

ถ้ายังไม่ตั้งค่า แอปจะทำงานแบบเก็บข้อมูลในเครื่องอย่างเดียว ระบบสมาชิกใช้ Firebase ฟรี (Spark plan) ตั้งค่าครั้งเดียวประมาณ 15 นาที

1. **สร้างโปรเจกต์** ที่ https://console.firebase.google.com → Add project
2. **เพิ่ม Web app** (ไอคอน `</>`) → คัดลอกค่า `firebaseConfig` มาใส่ใน `js/firebase-config.js`
3. **Authentication** → Get started → Sign-in method
   - เปิด **Google**
   - เปิด **Facebook**: สร้างแอปที่ https://developers.facebook.com (ประเภท Consumer, เพิ่มผลิตภัณฑ์ Facebook Login)
     นำ App ID / App secret มาใส่ใน Firebase แล้วคัดลอก *OAuth redirect URI* ที่ Firebase ให้
     ไปใส่ใน Facebook Login → Settings → Valid OAuth Redirect URIs จากนั้นเปลี่ยนแอป Facebook เป็นโหมด Live
   - **ห้ามเปิด** Email/Password เพราะคำเชิญอิงตามอีเมล
4. **Authentication → Settings → Authorized domains** → เพิ่ม `somkiatmsd.github.io`
5. **Firestore Database** → Create database (เลือก region `asia-southeast1`) → แท็บ **Rules**
   วางเนื้อหาจากไฟล์ `firestore.rules` แล้วกด Publish
6. commit `js/firebase-config.js` ขึ้น GitHub (ค่าเหล่านี้เปิดเผยได้ ความปลอดภัยอยู่ที่ rules)

### การชวนเพื่อน
- เปิดแผน → **👥 เพื่อนร่วมทาง** → ใส่อีเมลที่เพื่อนใช้กับ Google/Facebook → **เชิญ**
- เพื่อนเปิดแอปและเข้าระบบด้วยอีเมลนั้น จะเข้าร่วมแผนอัตโนมัติ (กด "แชร์ลิงก์ชวนเพื่อน" เพื่อส่งลิงก์ทาง LINE ได้)
- เจ้าของแผนเชิญ/ลบสมาชิกได้ สมาชิกแก้รายละเอียดทริปได้และออกจากแผนเองได้
- สถานที่ส่วนตัวของแต่ละคนยังเป็นส่วนตัว เพื่อนจะเห็นเฉพาะสถานที่ที่ใส่ไว้ในแผน
- บัญชี Facebook ที่ไม่มีอีเมล (สมัครด้วยเบอร์โทร) รับคำเชิญไม่ได้ ให้ใช้ Google แทน

### ทดสอบกับ Firebase Emulator
ใส่ `useEmulators: true` ใน `js/firebase-config.js` แล้วรัน
`npx firebase-tools emulators:start --project demo-wanderpin --only auth,firestore`

## โครงสร้าง
```
index.html             หน้าเดียว (4 แท็บ + ฟอร์ม)
css/style.css          สไตล์ รองรับโหมดมืด
js/store.js            เก็บข้อมูล places / plans (ในเครื่อง หรือซิงก์คลาวด์)
js/cloud.js            เข้าระบบ Google/Facebook + Firestore + เพื่อนร่วมทาง
js/firebase-config.js  ค่าโปรเจกต์ Firebase (ใส่เอง)
firestore.rules        กฎความปลอดภัยของฐานข้อมูล
js/app.js              แผนที่ รายการ ปฏิทิน แผน
sw.js                  แคชไฟล์แอป + ไทล์แผนที่สำหรับออฟไลน์
manifest.webmanifest   ข้อมูล PWA
vendor/leaflet         Leaflet 1.9.4 (BSD-2)
```
