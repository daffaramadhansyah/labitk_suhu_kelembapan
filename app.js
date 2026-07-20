// ==================== KONFIGURASI SUPABASE ====================
// Cukup masukkan Project ID saja (bukan URL lengkap) agar URL tidak ganda
const SUPABASE_PROJECT_ID = "vlbvghtpqqwetuqeaeke"; 
const SUPABASE_ANON_KEY   = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZsYnZnaHRwcXF3ZXR1cWVhZWtlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNjYzNzAsImV4cCI6MjA5OTY0MjM3MH0.rTnVO_EQBB99RUYg3Uf-ypMxn6DY4W6Jlc7bDOiTAa4"; 
// ==============================================================

const API_URL = `https://${SUPABASE_PROJECT_ID}.supabase.co/rest/v1`;
// CATATAN: Realtime (WebSocket) diblokir jaringan kampus, jadi pakai polling cepat sebagai gantinya.
// ESP32 kirim data tiap 5 detik, jadi polling di sini disamakan supaya tidak ada delay berarti.
const POLL_INTERVAL = 5000;

// Client Supabase (disimpan untuk kebutuhan lain, realtime subscription di-nonaktifkan)
const supabaseClient = window.supabase.createClient(
    `https://${SUPABASE_PROJECT_ID}.supabase.co`,
    SUPABASE_ANON_KEY
);

// APP STATE
let roomsData = [];
let filteredRooms = [];
let currentTab = "all";       // all, lab1, lab2
let currentFilter = "all";    // all, normal, warning, offline
let searchQuery = "";
let chartInstance = null;
let pollTimer = null;

// DOM ELEMENTS
const roomsGrid = document.getElementById("rooms-grid");
const searchInput = document.getElementById("search-input");
const btnRefresh = document.getElementById("btn-refresh");
const lastUpdatedTime = document.getElementById("last-updated-time");

// Stats elements
const statTotalRooms = document.getElementById("stat-total-rooms");
const statActiveSensors = document.getElementById("stat-active-sensors");
const statActiveDesc = document.getElementById("stat-active-desc");
const statAvgTemp = document.getElementById("stat-avg-temp");
const statAvgHumi = document.getElementById("stat-avg-humi");

// Modal elements
const detailModal = document.getElementById("detail-modal");
const btnCloseModal = document.getElementById("btn-close-modal");
const modalRoomName = document.getElementById("modal-room-name");
const modalRoomLab = document.getElementById("modal-room-lab");
const modalCurrTemp = document.getElementById("modal-curr-temp");
const modalCurrHumi = document.getElementById("modal-curr-humi");
const modalCurrStatus = document.getElementById("modal-curr-status");

// Sidebar & sub-header filter buttons
const navItems = document.querySelectorAll(".nav-item");
const filterBtns = document.querySelectorAll(".filter-btn");

// INITIALIZATION
document.addEventListener("DOMContentLoaded", () => {
    initEventListeners();
    fetchData();
    startPolling();     // polling cepat (5 detik), andalan utama karena WebSocket diblokir jaringan
    // setupRealtime(); // dinonaktifkan sementara: wss:// diblokir firewall jaringan kampus
});

// ==========================================
// REALTIME SUBSCRIPTION (Supabase)
// ==========================================
function setupRealtime() {
    if (SUPABASE_PROJECT_ID === "YOUR_SUPABASE_PROJECT_ID") return; // belum dikonfigurasi

    supabaseClient
        .channel('realtime-data-sensor')
        .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'data_sensor' },
            (payload) => {
                handleRealtimeInsert(payload.new);
            }
        )
        .subscribe((status) => {
            console.log('Status koneksi Realtime:', status);
        });
}

// Dipanggil setiap ada baris baru masuk ke tabel data_sensor
function handleRealtimeInsert(row) {
    const room = roomsData.find(r => r.kode_sensor === row.kode_sensor);
    if (!room) return; // sensor kirim data tapi ruangannya belum terdaftar di tabel ruangan

    room.suhu = parseFloat(row.suhu);
    room.kelembapan = parseFloat(row.kelembapan);
    room.waktu = row.waktu;

    updateStats();
    applyFilters();
    updateLastUpdatedTime();

    // Kalau modal detail ruangan ini sedang terbuka, update juga angka live-nya
    if (detailModal.classList.contains('active') && modalRoomName.dataset.kodeSensor === row.kode_sensor) {
        refreshModalLiveValues(room);
    }
}

// EVENT LISTENERS
function initEventListeners() {
    // Search
    searchInput.addEventListener("input", (e) => {
        searchQuery = e.target.value.toLowerCase();
        applyFilters();
    });

    // Refresh button
    btnRefresh.addEventListener("click", () => {
        const icon = btnRefresh.querySelector("i");
        icon.classList.add("fa-spin");
        fetchData().finally(() => {
            setTimeout(() => icon.classList.remove("fa-spin"), 600);
        });
    });

    // Sidebar navigation (Tabs)
    navItems.forEach(item => {
        item.addEventListener("click", (e) => {
            e.preventDefault();
            navItems.forEach(nav => nav.classList.remove("active"));
            item.classList.add("active");
            currentTab = item.getAttribute("data-tab");
            applyFilters();
        });
    });

    // Sub-header filter buttons
    filterBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            filterBtns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            currentFilter = btn.getAttribute("data-filter");
            applyFilters();
        });
    });

    // Filter rentang waktu di modal detail (5 Menit / 1 Jam / 12 Jam / 24 Jam)
    document.querySelectorAll('.range-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            currentRangeMinutes = parseInt(btn.dataset.range);
            const kodeSensor = modalRoomName.dataset.kodeSensor;
            if (kodeSensor) {
                loadChartForRange(kodeSensor, currentRangeMinutes);
            }
        });
    });

    // Modal close
    btnCloseModal.addEventListener("click", closeModal);
    detailModal.addEventListener("click", (e) => {
        if (e.target === detailModal) closeModal();
    });
}

// FETCH DATA FROM SUPABASE
async function fetchData() {
    if (SUPABASE_PROJECT_ID === "YOUR_SUPABASE_PROJECT_ID" || SUPABASE_ANON_KEY === "YOUR_SUPABASE_ANON_KEY") {
        console.log("Supabase belum dikonfigurasi. Menggunakan data simulasi...");
        roomsData = generateMockRooms();
        updateStats();
        applyFilters();
        updateLastUpdatedTime();
        return;
    }

    try {
        const url = `${API_URL}/ruangan?select=*,data_sensor(suhu,kelembapan,waktu)&data_sensor.order=waktu.desc&data_sensor.limit=1`;
        
        const response = await fetch(url, {
            method: "GET",
            headers: {
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
                "Content-Type": "application/json"
            }
        });

        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        
        const json = await response.json();
        
        roomsData = json.map(room => {
            const latestSensor = room.data_sensor && room.data_sensor.length > 0 ? room.data_sensor[0] : null;
            return {
                id_ruangan: room.id_ruangan,
                nama_ruangan: room.nama_ruangan,
                laboratorium: room.laboratorium,
                kode_sensor: room.kode_sensor,
                suhu: latestSensor ? parseFloat(latestSensor.suhu) : null,
                kelembapan: latestSensor ? parseFloat(latestSensor.kelembapan) : null,
                waktu: latestSensor ? latestSensor.waktu : null
            };
        });

    } catch (error) {
        console.error("Gagal mengambil data dari Supabase, menggunakan data simulasi...", error);
        roomsData = generateMockRooms();
    }
    
    updateStats();
    applyFilters();
    updateLastUpdatedTime();
}

// START POLLING
function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(fetchData, POLL_INTERVAL);
}

// UPDATE LAST UPDATED TIMESTAMP
function updateLastUpdatedTime() {
    const now = new Date();
    const timeString = now.toTimeString().split(' ')[0];
    lastUpdatedTime.textContent = timeString;
}

// UPDATE SUMMARY STATS
function updateStats() {
    const total = roomsData.length;
    const now = new Date();
    
    const activeRooms = roomsData.filter(r => {
        if (!r.waktu || r.suhu === null) return false;
        const lastUpdate = new Date(r.waktu);
        const diffMinutes = (now - lastUpdate) / 1000 / 60;
        return diffMinutes < 15;
    });
    
    const activeCount = activeRooms.length;
    
    let tempSum = 0;
    let humiSum = 0;
    let validSensorCount = 0;
    
    roomsData.forEach(r => {
        if (r.suhu !== null && r.kelembapan !== null) {
            tempSum += r.suhu;
            humiSum += r.kelembapan;
            validSensorCount++;
        }
    });
    
    const avgTemp = validSensorCount > 0 ? (tempSum / validSensorCount).toFixed(1) : "--";
    const avgHumi = validSensorCount > 0 ? (humiSum / validSensorCount).toFixed(0) : "--";
    
    statTotalRooms.textContent = total;
    statActiveSensors.textContent = activeCount;
    statActiveDesc.textContent = `${activeCount} online dari 54 ruangan`;
    statAvgTemp.textContent = avgTemp !== "--" ? `${avgTemp}°C` : "--°C";
    statAvgHumi.textContent = avgHumi !== "--" ? `${avgHumi}%` : "--%";
}

// APPLY ALL FILTERS (Sidebar + Sub-header + Search)
function applyFilters() {
    filteredRooms = roomsData.filter(room => {
        if (currentTab === "lab1" && room.laboratorium !== "Lab 1") return false;
        if (currentTab === "lab2" && room.laboratorium !== "Lab 2") return false;
        
        const isOffline = checkIsOffline(room);
        const status = isOffline ? "offline" : getStatusLabel(room.suhu, room.kelembapan);
        
        if (currentFilter === "normal" && status !== "normal") return false;
        if (currentFilter === "warning" && (status !== "warning" && status !== "danger")) return false;
        if (currentFilter === "offline" && status !== "offline") return false;
        
        if (searchQuery) {
            const nameMatch = room.nama_ruangan.toLowerCase().includes(searchQuery);
            const codeMatch = room.kode_sensor.toLowerCase().includes(searchQuery);
            return nameMatch || codeMatch;
        }
        
        return true;
    });
    
    renderRooms();
}

// CHECK IF OFFLINE (No update > 15 mins)
function checkIsOffline(room) {
    if (!room.waktu || room.suhu === null) return true;
    const now = new Date();
    const lastUpdate = new Date(room.waktu);
    const diffMinutes = (now - lastUpdate) / 1000 / 60;
    return diffMinutes > 15;
}

// GET STATUS TEXT BASED ON TEMP & HUMIDITY
function getStatusLabel(temp, humi) {
    if (temp === null) return "offline";
    if (temp > 33 || temp < 18 || humi > 70 || humi < 30) {
        return "danger"; 
    } else if (temp > 30 || temp < 20 || humi > 60 || humi < 40) {
        return "warning"; 
    }
    return "normal";
}

// RENDER ROOM CARDS
function renderRooms() {
    roomsGrid.innerHTML = "";
    
    if (filteredRooms.length === 0) {
        roomsGrid.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <p>Tidak ada ruangan yang cocok dengan filter atau pencarian Anda.</p>
            </div>
        `;
        return;
    }
    
    filteredRooms.forEach(room => {
        const isOffline = checkIsOffline(room);
        const statusLabel = isOffline ? "offline" : getStatusLabel(room.suhu, room.kelembapan);
        
        const card = document.createElement("div");
        card.className = `room-card ${room.laboratorium === 'Lab 1' ? 'lab-1-card' : 'lab-2-card'} ${isOffline ? 'offline-card' : ''}`;
        card.addEventListener("click", () => openModal(room.kode_sensor));
        
        const tempText = isOffline ? "--" : `${room.suhu.toFixed(1)}°C`;
        const humiText = isOffline ? "--" : `${room.kelembapan.toFixed(1)}%`;
        
        let timeAgoText = "Belum ada data";
        if (room.waktu) {
            const date = new Date(room.waktu);
            const hrs = String(date.getHours()).padStart(2, '0');
            const mins = String(date.getMinutes()).padStart(2, '0');
            timeAgoText = `Update: ${hrs}:${mins}`;
        }
        
        card.innerHTML = `
            <div class="room-card-header">
                <div class="room-info">
                    <h4>${room.nama_ruangan}</h4>
                    <span class="lab-badge">${room.laboratorium === 'Lab 1' ? 'Lab Terpadu 1' : 'Lab Terpadu 2'}</span>
                </div>
                <span class="status-indicator-dot ${statusLabel}"></span>
            </div>
            
            <div class="room-readings">
                <div class="reading temp">
                    <span class="label">Suhu</span>
                    <span class="value">${tempText}</span>
                </div>
                <div class="reading humi">
                    <span class="label">Kelembapan</span>
                    <span class="value">${humiText}</span>
                </div>
            </div>
            
            <div class="room-footer">
                <span><i class="fa-solid fa-microchip"></i> ${room.kode_sensor}</span>
                <span>${timeAgoText}</span>
            </div>
        `;
        
        roomsGrid.appendChild(card);
    });
}

// MODAL CONTROLS
let currentRangeMinutes = 60; // default: 1 jam

async function openModal(kodeSensor) {
    detailModal.classList.add("active");
    currentRangeMinutes = 60; // reset ke default tiap buka modal baru

    document.querySelectorAll('.range-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.range) === currentRangeMinutes);
    });

    modalRoomName.textContent = "Memuat data...";
    modalCurrTemp.textContent = "--°C";
    modalCurrHumi.textContent = "--%";
    modalCurrStatus.className = "value status-badge offline";
    modalCurrStatus.textContent = "...";
    
    if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
    }
    
    const room = roomsData.find(r => r.kode_sensor === kodeSensor);
    if (!room) return;
    
    modalRoomName.textContent = room.nama_ruangan;
    modalRoomName.dataset.kodeSensor = room.kode_sensor;
    modalRoomLab.textContent = room.laboratorium === 'Lab 1' ? 'Lab Terpadu 1' : 'Lab Terpadu 2';
    modalRoomLab.className = `lab-badge ${room.laboratorium === 'Lab 1' ? 'bg-blue' : 'bg-teal'}`;
    
    const isOffline = checkIsOffline(room);
    
    if (isOffline) {
        modalCurrTemp.textContent = "--";
        modalCurrHumi.textContent = "--";
        modalCurrStatus.className = "value status-badge offline";
        modalCurrStatus.textContent = "Offline";
    } else {
        modalCurrTemp.textContent = `${room.suhu.toFixed(1)}°C`;
        modalCurrHumi.textContent = `${room.kelembapan.toFixed(1)}%`;
        
        const statusLabel = getStatusLabel(room.suhu, room.kelembapan);
        modalCurrStatus.className = `value status-badge ${statusLabel}`;
        modalCurrStatus.textContent = statusLabel.toUpperCase();
    }

    await loadChartForRange(kodeSensor, currentRangeMinutes, room);
}

// Setiap "titik" grafik selalu berjumlah segini, tinggal ukuran bucket-nya yang beda per tombol
const BUCKET_POINTS = 12;

// Dipanggil tiap kali tombol rentang waktu diklik.
// bucketMinutes = ukuran 1 "blok" data (mis. 5 menit / 1 jam / 12 jam),
// total rentang yang ditampilkan = bucketMinutes x 12.
async function loadChartForRange(kodeSensor, bucketMinutes, roomFallback) {
    const room = roomFallback || roomsData.find(r => r.kode_sensor === kodeSensor);

    if (SUPABASE_PROJECT_ID === "YOUR_SUPABASE_PROJECT_ID" || SUPABASE_ANON_KEY === "YOUR_SUPABASE_ANON_KEY") {
        const startTemp = (room && room.suhu) || 24;
        const startHumi = (room && room.kelembapan) || 50;
        renderChart(generateMockHistory(startTemp, startHumi));
        return;
    }

    try {
        const { data, error } = await supabaseClient.rpc('get_bucketed_readings', {
            p_kode_sensor: kodeSensor,
            p_bucket_minutes: bucketMinutes,
            p_num_buckets: BUCKET_POINTS
        });

        if (error) throw error;

        // Bucket kosong (tidak ada data di rentang itu) dilewati, bukan dianggap 0
        const rows = (data || []).filter(r => r.avg_suhu !== null && r.avg_kelembapan !== null);

        // Tampilkan tanggal juga di label kalau ukuran bucket-nya besar (1 Jam / 12 Jam),
        // supaya jelas walau rentangnya melewati pergantian hari
        const useDateLabel = bucketMinutes >= 60;

        const history = rows.map(row => {
            const time = new Date(row.bucket_start);
            const jam = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
            const label = useDateLabel
                ? `${String(time.getDate()).padStart(2, '0')}/${String(time.getMonth() + 1).padStart(2, '0')} ${jam}`
                : jam;
            return {
                suhu: parseFloat(row.avg_suhu),
                kelembapan: parseFloat(row.avg_kelembapan),
                waktu: label
            };
        });

        if (history.length === 0) {
            renderChart([]); // chart kosong, ada penanganan "belum ada data" di renderChart
            return;
        }

        renderChart(history);
    } catch (err) {
        console.error('Gagal mengambil data histori:', err);
        renderChart([]);
    }
}

function closeModal() {
    detailModal.classList.remove("active");
    delete modalRoomName.dataset.kodeSensor;
}

// Update angka live di modal (dipanggil dari realtime handler, tanpa reload chart)
function refreshModalLiveValues(room) {
    const isOffline = checkIsOffline(room);

    if (isOffline) {
        modalCurrTemp.textContent = "--";
        modalCurrHumi.textContent = "--";
        modalCurrStatus.className = "value status-badge offline";
        modalCurrStatus.textContent = "Offline";
    } else {
        modalCurrTemp.textContent = `${room.suhu.toFixed(1)}°C`;
        modalCurrHumi.textContent = `${room.kelembapan.toFixed(1)}%`;

        const statusLabel = getStatusLabel(room.suhu, room.kelembapan);
        modalCurrStatus.className = `value status-badge ${statusLabel}`;
        modalCurrStatus.textContent = statusLabel.toUpperCase();
    }
}

// RENDER CHART.JS LINE GRAPH
function renderChart(history) {
    // WAJIB: hancurkan instance chart lama dulu sebelum bikin yang baru,
    // kalau tidak Chart.js akan gagal render chart baru di canvas yang sama
    // (menyebabkan chart lama tetap "nyangkut" di layar meski data baru sudah di-fetch)
    if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
    }

    const ctx = document.getElementById('history-chart').getContext('2d');
    
    const labels = history.map(item => item.waktu);
    const temps = history.map(item => item.suhu);
    const humis = history.map(item => item.kelembapan);
    
    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Suhu (°C)',
                    data: temps,
                    borderColor: '#f59e0b',
                    backgroundColor: 'rgba(245, 158, 11, 0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    yAxisID: 'y-temp',
                    fill: true,
                    pointRadius: 0,
                    pointHoverRadius: 4
                },
                {
                    label: 'Kelembapan (%)',
                    data: humis,
                    borderColor: '#14b8a6',
                    backgroundColor: 'rgba(20, 184, 166, 0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    yAxisID: 'y-humi',
                    fill: true,
                    pointRadius: 0,
                    pointHoverRadius: 4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: { color: '#94a3b8', font: { family: 'Inter' } }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.03)' },
                    ticks: {
                        color: '#94a3b8',
                        maxTicksLimit: 8,
                        autoSkip: true,
                        maxRotation: 0
                    }
                },
                'y-temp': {
                    type: 'linear',
                    position: 'left',
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#f59e0b' },
                    title: { display: true, text: 'Suhu (°C)', color: '#f59e0b' }
                },
                'y-humi': {
                    type: 'linear',
                    position: 'right',
                    grid: { display: false },
                    ticks: { color: '#14b8a6' },
                    title: { display: true, text: 'Kelembapan (%)', color: '#14b8a6' }
                }
            }
        }
    });
}

// ==========================================
// MOCK DATA GENERATORS FOR TESTING
// ==========================================
function generateMockRooms() {
    const list = [];
    const now = new Date();
    
    const lab1Names = [
        "Workshop B - Perakitan (R102)",
        "Lab. Rekayasa Konstruksi dan Transportasi (R103)",
        "Lab Uji Destruktif dan Non Destruktif (R104)",
        "Lab. Teknologi Proses (R105)",
        "Lab. Sistem Tenaga Listrik dan Otomasi (R106)",
        "Lab. Karakterisasi A (R107)",
        "Lab. Karakterisasi B (R108)",
        "Lab. Termal (R109)",
        "Lab. Kimia Dasar A (R201)",
        "Lab. Fisika Dasar",
        "Kantor Administrasi A (R203)",
        "Kantor Administrasi B (R204)",
        "Ruang Kerja Bersama (R205)",
        "Ruang Kerja Bersama (R206)",
        "Workshop A - Manufaktur (R101)",
        "Lab. Kimia Dasar B (R208)",
        "Lab. Komputer A (R301)",
        "Lab. Komputer B (R302)",
        "Lab. Komputer C (R303)",
        "Lab. Komputer D (R304)",
        "Lab. Komputer E (R305)",
        "Lab. Komputer F (R306)",
        "Lab. Komputer G (R307)",
        "Lab. Karakterisasi C (R101)"
    ];
    
    const lab2Names = [
        "Lab. Operasi Teknologi Kimia (R102)",
        "Lab. Rekayasa Lingkungan dan Pengolahan Limbah (R103)",
        "Lab. Rekayasa Industri dan Ergonomi (R106)",
        "Lab. Rekayasa Keselamatan (R107)",
        "Lab. Proses Produksi 1 (R108)",
        "Lab. Proses Produksi 2 DT & NDT (R108)",
        "Lab. Permesinan dan Konversi Energi (R109)",
        "Lab. Konstruksi Bangunan Laut (R115)",
        "Lab. Geoteknik dan Ukur Tanah (R116)",
        "Lab. Hidrodinamika dan Aerodinamika (R118)",
        "Lab. Pusat Penelitian Energi (R201)",
        "Lab. Kimia Material (R202)",
        "Lab. Pusat Penelitian Pangan Pertanian (R203)",
        "Lab. Teknologi Pangan (R204)",
        "Kantor Administrasi (R205)",
        "Lab Logistik & Manajemen Rantai Pasok (R206)",
        "Ruang Seminar (R207)",
        "Lab Fisika Lanjut (R301)",
        "Lab Elektronika dan Robotika (R302)",
        "Lab Komputasi Tinggi (R303)",
        "Lab Telekomunikasi dan Jaringan Komputer (R304)",
        "Lab Pengembangan Perangkat Lunak (R305)",
        "Studio Perencanaan Tata Ruang (R306)",
        "Studio Arsitektur dan Desain (R307)",
        "Lab Pusat Penelitian Smart City (R308)"
    ];

    lab1Names.forEach((name, index) => {
        const i = index + 1;
        const padId = String(i).padStart(2, '0');
        const temp = 21 + Math.random() * 6;
        const humi = 45 + Math.random() * 18;
        const isOffline = true;
        
        list.push({
            id_ruangan: i,
            nama_ruangan: name,
            laboratorium: "Lab 1",
            kode_sensor: `LAB1_R${padId}`,
            suhu: isOffline ? null : temp,
            kelembapan: isOffline ? null : humi,
            waktu: isOffline ? null : new Date(now.getTime() - Math.random() * 10 * 60000).toISOString()
        });
    });
    
    lab2Names.forEach((name, index) => {
        const i = index + 1;
        const padId = String(i).padStart(2, '0');
        const temp = 20 + Math.random() * 7;
        const humi = 40 + Math.random() * 22;
        const isOffline = true;

        list.push({
            id_ruangan: 24 + i,
            nama_ruangan: name,
            laboratorium: "Lab 2",
            kode_sensor: `LAB2_R${padId}`,
            suhu: isOffline ? null : temp,
            kelembapan: isOffline ? null : humi,
            waktu: isOffline ? null : new Date(now.getTime() - Math.random() * 10 * 60000).toISOString()
        });
    });
    
    return list;
}

function generateMockHistory(baseTemp, baseHumi) {
    const list = [];
    const temp = baseTemp || 23.5;
    const humi = baseHumi || 52.0;
    const now = new Date();
    
    for (let i = 19; i >= 0; i--) {
        const time = new Date(now.getTime() - i * 15 * 60000);
        const tempNoise = (Math.random() - 0.5) * 0.8;
        const humiNoise = (Math.random() - 0.5) * 4;
        
        list.push({
            suhu: parseFloat((temp + tempNoise).toFixed(1)),
            kelembapan: parseFloat((humi + humiNoise).toFixed(0)),
            waktu: `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
        });
    }
    
    return list;
}