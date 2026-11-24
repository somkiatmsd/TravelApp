# Wanderpin – แอปเก็บสถานที่ที่อยากไปเที่ยว (PWA)

เว็บแอปแบบ Progressive Web App ติดตั้งลงมือถือ/คอมได้ และใช้งานออฟไลน์ได้

## ฟีเจอร์
- **ปักหมุด** – แตะบนแผนที่, ค้นหาชื่อสถานที่ (OpenStreetMap), หรือใช้ตำแหน่งปัจจุบัน
- **แผนที่** – หมุดสีส้ม = ยังไม่ได้ไป, สีเขียว = ไปแล้ว พร้อมปุ่มนำทางผ่าน Google Maps
- **รายการ** – แยกแท็บ *ยังไม่ได้ไป* / *ไปแล้ว* ค้นหา เรียงลำดับ และติ๊กว่าไปแล้วได้ทันที
- **ปฏิทิน** – แสดงแผนเที่ยวและวันที่ไปสถานที่ต่างๆ ในแต่ละวัน (ปี พ.ศ.)
- **แผนเที่ยว** – กำหนดชื่อ วันเริ่ม–สิ้นสุด สี เลือกสถานที่ตามลำดับ ดูเส้นทางบนแผนที่ และดูความคืบหน้า
- **โปรไฟล์** – เข้าระบบด้วย Google แล้วตั้งชื่อ รูป และคำแนะนำตัว เลือกได้ว่าจะเป็นโปรไฟล์สาธารณะ (ทุกคนค้นหาเจอ) หรือส่วนตัว (เห็นเฉพาะเพื่อน)
- **เพื่อน** – ค้นหานักเดินทางที่เป็นสาธารณะ ดูหน้าโปรไฟล์ ส่งคำขอเป็นเพื่อน อีกฝ่ายต้องกดยอมรับก่อนจึงจะเป็นเพื่อนกัน
- **เพื่อนร่วมทาง** – เจ้าของแผนชวนได้เฉพาะคนที่เป็นเพื่อนแล้ว ดูรายชื่อสมาชิก ลบสมาชิก หรือออกจากแผนได้ ทุกคนในแผนเห็นสถานที่และแก้แผนร่วมกันได้แบบเรียลไทม์
- **ข้อมูล** – ถ้าไม่เข้าระบบจะเก็บในเครื่อง (localStorage) ส่งออก/นำเข้าเป็นไฟล์ JSON เพื่อสำรองหรือย้ายเครื่อง

## วิธีรัน
ไม่ต้อง build ใช้ static server ตัวไหนก็ได้ เช่น

```bash
python3 -m http.server 8080
# เปิด http://localhost:8080
```

การติดตั้งเป็นแอปและ Service Worker ต้องเปิดผ่าน `https://` หรือ `localhost`
(เช่น GitHub Pages: Settings → Pages → Deploy from branch)

## เปิดระบบสมาชิก / เพื่อน (Firebase)

ถ้ายังไม่ตั้งค่า แอปจะทำงานแบบเก็บข้อมูลในเครื่องอย่างเดียว ระบบสมาชิกใช้ Firebase ฟรี (Spark plan)

1. **สร้างโปรเจกต์** ที่ https://console.firebase.google.com → Create a project
2. **เพิ่ม Web app** (ไอคอน `</>`) → คัดลอกค่า `firebaseConfig` มาใส่ใน `js/firebase-config.js`
3. **Authentication** → Get started → Sign-in method → เปิด **Google**
   (ห้ามเปิด Email/Password)
4. **Authentication → Settings → Authorized domains** → เพิ่ม `somkiatmsd.github.io`
5. **Databases → Firestore** → Create database (Standard, Database ID `(default)`, region `asia-southeast1`, production mode)
6. แท็บ **Rules** → วางเนื้อหาจากไฟล์ `firestore.rules` แล้วกด **Publish**
   (ทุกครั้งที่ไฟล์นี้เปลี่ยน ต้องวางและ Publish ใหม่)

### เพื่อนและการชวนไปเที่ยว
- แท็บ **เพื่อน**: แก้ไขโปรไฟล์ของฉัน, คำขอเป็นเพื่อนที่เข้ามา (ยอมรับ/ปฏิเสธ), รายชื่อเพื่อน, คำขอที่ส่งไป และรายชื่อนักเดินทางสาธารณะ
- แตะชื่อใครก็ได้เพื่อดูหน้าโปรไฟล์ (รูป ชื่อ แนะนำตัว จำนวนที่ปักหมุด/ไปแล้ว/แผน) และกด **+ เพิ่มเพื่อน**
- ส่งคำขอได้เฉพาะโปรไฟล์สาธารณะ โปรไฟล์ส่วนตัวจะเห็นได้เฉพาะเพื่อน
- ในแผน กด **👥 เพื่อนร่วมทาง** → เลือกเพื่อนที่จะชวน (เจ้าของแผนเท่านั้น และชวนได้เฉพาะเพื่อน)
- สถานที่ส่วนตัวยังเป็นส่วนตัว เพื่อนร่วมทางเห็นเฉพาะสถานที่ที่อยู่ในแผน อีเมลไม่แสดงให้ใครเห็น
- รูปโปรไฟล์ถูกย่อเหลือ 320px และเก็บใน Firestore (ไม่ต้องใช้ Firebase Storage)

## ค้นหาสถานที่ด้วย Google (ไม่บังคับ)

แผนที่ยังเป็น OpenStreetMap (ใช้ออฟไลน์ได้) แต่ช่องค้นหาจะใช้ Google Places เมื่อใส่ API key ใน `js/maps-config.js`
ถ้าไม่มี key หรือ Google ใช้ไม่ได้ จะค้นหาด้วย OpenStreetMap แทนอัตโนมัติ

1. https://console.cloud.google.com → สร้างโปรเจกต์ใหม่ (แยกจาก Firebase เพื่อให้ Firebase อยู่แผนฟรีต่อ)
2. ผูก Billing account (ต้องใช้บัตร แต่มีโควตาฟรีรายเดือน)
3. เปิดใช้ **Maps JavaScript API** และ **Places API (New)**
4. Credentials → Create credentials → API key แล้วจำกัด key:
   - Application restrictions: Websites → `https://somkiatmsd.github.io/*`
   - API restrictions: Maps JavaScript API, Places API (New)
5. ตั้ง Budget alert และจำกัดโควตารายวันของ Places API กันค่าใช้จ่ายเกิน
6. ใส่ key ใน `js/maps-config.js`

### ทดสอบกับ Firebase Emulator
ใส่ `useEmulators: true` ใน `js/firebase-config.js` แล้วรัน
`npx firebase-tools emulators:start --project demo-wanderpin --only auth,firestore`

## โครงสร้าง
```
index.html             หน้าเดียว (4 แท็บ + ฟอร์ม)
css/style.css          สไตล์ รองรับโหมดมืด
js/store.js            เก็บข้อมูล places / plans (ในเครื่อง หรือซิงก์คลาวด์)
js/cloud.js            เข้าระบบ Google + Firestore (สถานที่ แผน โปรไฟล์ เพื่อน)
js/social.js           โปรไฟล์ แท็บเพื่อน หน้าโปรไฟล์สาธารณะ
js/ui.js               ฟังก์ชันช่วยเรื่องหน้าจอ
js/search.js           ค้นหาสถานที่ (Google Places หรือ OpenStreetMap)
js/maps-config.js      Google Maps API key (ไม่บังคับ)
js/firebase-config.js  ค่าโปรเจกต์ Firebase
firestore.rules        กฎความปลอดภัยของฐานข้อมูล
js/app.js              แผนที่ รายการ ปฏิทิน แผน
sw.js                  แคชไฟล์แอป + ไทล์แผนที่สำหรับออฟไลน์
manifest.webmanifest   ข้อมูล PWA
vendor/leaflet         Leaflet 1.9.4 (BSD-2)
```
