/**
 * Tiện ích thuế 3 trong 1 - SĐT: 0963819339
 * Module: Nhận Diện Nhà Cung Cấp Hóa Đơn Điện Tử & Bóc Tách Link/Mã Tra Cứu
 */

const INVOICE_PROVIDERS = [
  {
    "STT": "1",
    "name": "Công ty TNHH Công nghệ Vĩnh Hy",
    "MST": "0314743623",
    "homePage": "http://ehoadondientu.com",
    "lookup": "https://ehoadondientu.com/Tra-cuu"
  },
  {
    "STT": "2",
    "name": "Công ty TNHH Hệ thống thông tin FPT",
    "MST": "0104128565",
    "homePage": "https://einvoice.fpt.com.vn",
    "lookup": "https://hoadon.ftg.vn/"
  },
  {
    "STT": "3",
    "name": "Công ty Cổ phần Công nghệ tin học EFY Việt Nam",
    "MST": "0102519041",
    "homePage": "https://ihoadon.vn",
    "lookup": "https://ihoadon.vn/kiem-tra/?lang=vn"
  },
  {
    "STT": "4",
    "name": "Công ty Cổ phần Đầu tư công nghệ và thương mại Softdreams",
    "MST": "0105987432",
    "homePage": "https://easyinvoice.vn",
    "lookup": "https://tracuu.easyinvoice.vn/"
  },
  {
    "STT": "5",
    "name": "Công ty TNHH L.C.S",
    "MST": "0302999571",
    "homePage": "https://lcs.com.vn/site",
    "lookup": "https://eip.lcssoft.com.vn/desktop/#/login"
  },
  {
    "STT": "6",
    "name": "Công ty TNHH Soft Ware KK VAT",
    "MST": "0313963672",
    "homePage": "http://kkvat.com.vn/thongtin",
    "lookup": "https://tracuuhoadon.kkvat.com.vn/"
  },
  {
    "STT": "7",
    "name": "Công ty Cổ phần CyberLotus",
    "MST": "0105232093",
    "homePage": "https://cyberbill.vn",
    "lookup": "https://tracuuhoadon1.xcyber.vn/#/tracuuhoadon/tracuu"
  },
  {
    "STT": "8",
    "name": "Công ty TNHH Giải pháp công nghệ Ngô Gia Phát",
    "MST": "0311942758",
    "homePage": "http://www.ngogiaphat.vn",
    "lookup": "https://tracuuonline78.ngogiaphat.vn/Search"
  },
  {
    "STT": "9",
    "name": "Công ty Cổ phần Mắt Bão",
    "MST": "0302712571",
    "homePage": "https://matbao.in",
    "lookup": "https://matbao.in/tra-cuu-hoa-don/"
  },
  {
    "STT": "10",
    "name": "Công ty Cổ phần công nghệ thẻ Nacencomm",
    "MST": "0103930279",
    "homePage": "https://www.nacencomm.vn/",
    "lookup": "https://hoadon78_logigo.nacencomm.vn/"
  },
  {
    "STT": "11",
    "name": "Công ty Cổ phần Megabiz Việt Nam",
    "MST": "0105844836",
    "homePage": "https://vinvoice.vn",
    "lookup": "https://tracuu.vinvoice.vn/"
  },
  {
    "STT": "12",
    "name": "Công ty TNHH Công nghệ LCD Việt Nam",
    "MST": "0312483391",
    "homePage": "https://www.qtsc.com.vn/business/detail/550",
    "lookup": ""
  },
  {
    "STT": "13",
    "name": "Công ty Cổ phần MISA",
    "MST": "0101243150",
    "homePage": "https://www.meinvoice.vn/",
    "lookup": "https://www.meinvoice.vn/tra-cuu/"
  },
  {
    "STT": "14",
    "name": "Công ty TNHH Hóa đơn điện tử M-INVOICE",
    "MST": "0106026495",
    "homePage": "https://minvoice.vn/",
    "lookup": "https://tracuuhoadon.minvoice.com.vn/tra-cuu-hoa-don"
  },
  {
    "STT": "15",
    "name": "Công ty Cổ phần Phát triển công nghệ Nguyễn Minh",
    "MST": "0313906508",
    "homePage": "www.nguyenminhvat.vn",
    "lookup": "https://nguyenminhvat.vn/hddt/sinv/sinv00101"
  },
  {
    "STT": "16",
    "name": "Công ty TNHH Phát triển công nghệ Thái Sơn",
    "MST": "0101300842",
    "homePage": "https://einvoice.com.vn/",
    "lookup": "https://einvoice.vn/tra-cuu"
  },
  {
    "STT": "17",
    "name": "Công ty TNHH Máy tính và truyền thông công nghệ kết nối",
    "MST": "0306784030",
    "homePage": "https://ehoadon.online",
    "lookup": "https://ehoadon.online/einvoice/lookup"
  },
  {
    "STT": "18",
    "name": "Công ty Cổ phần công nghệ số và in đồ họa",
    "MST": "0200638946",
    "homePage": "https://oinvoice.vn",
    "lookup": "https://oinvoice.vn/tracuu/"
  },
  {
    "STT": "19",
    "name": "Công ty TNHH Win Tech Solution",
    "MST": "0312303803",
    "homePage": "https://wininvoice.vn",
    "lookup": "https://tracuu.wininvoice.vn/"
  },
  {
    "STT": "20",
    "name": "Tập đoàn Công nghiệp - Viễn thông quân đội",
    "MST": "0100109106",
    "homePage": "https://vinvoice.viettel.vn/utilities/invoice-search",
    "lookup": "https://vinvoice.viettel.vn/utilities/invoice-search"
  },
  {
    "STT": "21",
    "name": "Công ty Cổ phần Công nghệ thông tin Đông Nam Á",
    "MST": "0102454468",
    "homePage": "https://tax24.com.vn/thuedientu/san-pham-dich-vu/hoa-don-dien-tu.",
    "lookup": "https://tax24.com.vn/thuedientu/xac-minh-hoa-don"
  },
  {
    "STT": "22",
    "name": "Công ty Cổ phần hóa đơn điện tử New-Invoice",
    "MST": "0105937449",
    "homePage": "https://newinvoice.com.vn",
    "lookup": "https://newinvoice.com.vn/tra-cuu/"
  },
  {
    "STT": "23",
    "name": "Công ty Cổ phần Giải pháp phần mềm 3A",
    "MST": "0108516079",
    "homePage": "http://3asoft.vn",
    "lookup": "http://hddt.3asoft.vn/"
  },
  {
    "STT": "24",
    "name": "Tổng công ty Viễn thông Mobifone",
    "MST": "0100686209",
    "homePage": "https://itc.mobifone.vn/giai_phap/mobifone-invoice",
    "lookup": "http://tracuuhoadon.mobifoneinvoice.vn/trang-chu"
  },
  {
    "STT": "25",
    "name": "Công ty Cổ phần BKAV",
    "MST": "0101360697",
    "homePage": "https://van.ehoadon.vn",
    "lookup": "https://van.ehoadon.vn/TCHD"
  },
  {
    "STT": "26",
    "name": "Công ty Cổ phần phát triển phần mềm ASIA",
    "MST": "0101162173",
    "homePage": "https://asiainvoice.vn",
    "lookup": "https://asiainvoice.vn/tra-cuu"
  },
  {
    "STT": "27",
    "name": "Công ty Cổ phần thương mại Visnam",
    "MST": "0401486901",
    "homePage": "https://vin-hoadon.com",
    "lookup": "https://tracuu.vin-hoadon.com/tracuuhoadon/tracuuxacthuc/tracuuhd"
  },
  {
    "STT": "28",
    "name": "Công ty Cổ phần Thiết bị điện - Điện tử Bách Khoa",
    "MST": "0200784873",
    "homePage": "https://dinhvibachkhoa.vn",
    "lookup": "https://hoadonbachkhoa.pmbk.vn/tra-cuu-hoa-don"
  },
  {
    "STT": "29",
    "name": "Tập Đoàn Bưu chính viễn thông Việt Nam",
    "MST": "0100684378",
    "homePage": "https://vnpt-invoice.com.vn/",
    "lookup": "https://portaltool-miennam.vnpt-invoice.com.vn/"
  },
  {
    "STT": "30",
    "name": "Công ty Cổ phần dịch vụ T-VAN HILO",
    "MST": "0106713804",
    "homePage": "https://hiloinvoice.vn",
    "lookup": "https://tracuuhddt78.hilo.com.vn/"
  },
  {
    "STT": "31",
    "name": "Công ty Cổ phần Minh Khang Group",
    "MST": "0314209362",
    "homePage": "http://hoadondientuvat.com",
    "lookup": "https://hoadondientuvat.com/Tracuu.aspx"
  },
  {
    "STT": "32",
    "name": "Công ty Cổ phần Giải pháp hóa đơn điện tử Việt Nam",
    "MST": "0101352495",
    "homePage": "https://tracuu.v50.vninvoice.vn/",
    "lookup": "https://tracuu.v50.vninvoice.vn/"
  },
  {
    "STT": "33",
    "name": "Công ty Cổ phần giải pháp thanh toán Việt Nam",
    "MST": "0102182292",
    "homePage": "https://www.vnpay.vn",
    "lookup": "https://portal.vnpayinvoice.vn/"
  },
  {
    "STT": "34",
    "name": "Công ty Cổ phần ICORP",
    "MST": "0106870211",
    "homePage": "https://vietinvoice.vn",
    "lookup": "https://tracuu.vietinvoice.vn/#/"
  },
  {
    "STT": "35",
    "name": "Công ty Cổ phần đầu tư và công nghệ idocNet",
    "MST": "0104614692",
    "homePage": "https://hoadontvan.com",
    "lookup": "https://hoadontvan.com/TraCuu"
  },
  {
    "STT": "36",
    "name": "Công ty Cổ phần chữ ký số VI NA",
    "MST": "0309612872",
    "homePage": "www.smartsign.com.vn",
    "lookup": "https://tracuuhd.smartsign.com.vn/"
  },
  {
    "STT": "37",
    "name": "Công ty Cổ phần TS24",
    "MST": "0309478306",
    "homePage": "https://tracuu.xuathoadon.vn/",
    "lookup": "https://tracuu.xuathoadon.vn/"
  },
  {
    "STT": "38",
    "name": "Công ty TNHH Hóa đơn điện tử TCT",
    "MST": "0315298333",
    "homePage": "https://www.tctinvoice.com ",
    "lookup": "https://tctinvoice.com/"
  },
  {
    "STT": "39",
    "name": "Công ty TNHH Tin học Tia lửa Việt",
    "MST": "0303609305",
    "homePage": "https://ihoadondientu.com",
    "lookup": "https://ihoadondientu.com/Tra-cuu"
  },
  {
    "STT": "40",
    "name": "Công ty Cổ phần phần mềm quản lý doanh nghiệp",
    "MST": "0100727825",
    "homePage": "https://www.fast.com.vn",
    "lookup": "https://einvoice.fast.com.vn/"
  },
  {
    "STT": "41",
    "name": "Công ty TNHH ACCONLINE.VN",
    "MST": "0315467091",
    "homePage": "https://www.acconline.vn/vn/index.html",
    "lookup": "https://www.acconline.vn/vn/tra-cuu-hoa-don.htm"
  },
  {
    "STT": "42",
    "name": "Công ty Cổ phần công nghệ hóa đơn điện tử HT",
    "MST": "0315638251",
    "homePage": "http://htinvoice.com.vn",
    "lookup": "https://htinvoice.com.vn/TraCuu"
  },
  {
    "STT": "43",
    "name": "Công ty Cổ phần công nghệ ITT",
    "MST": "0105958921",
    "homePage": "https://cloudinvoice.vn",
    "lookup": "https://tracuu.cloudinvoice.vn/"
  },
  {
    "STT": "44",
    "name": "Công ty TNHH PA Việt Nam",
    "MST": "0302431595",
    "homePage": "https://hoadon30s.vn",
    "lookup": "https://tracuu.hoadon30s.vn"
  },
  {
    "STT": "45",
    "name": "Công ty Cổ phần tích hợp công nghệ VNISC",
    "MST": "0103018807",
    "homePage": "https://vnisc.com.vn",
    "lookup": "https://abcsys.vn/Invoice/Search"
  },
  {
    "STT": "46",
    "name": "Công ty TNHH Giải pháp hóa đơn điện tử My – Invoice",
    "MST": "0106820789",
    "homePage": "https://hoadondientuvn.info",
    "lookup": "https://tracuu.hoadondientuvn.info/#/tracuuhoadon/tracuu"
  },
  {
    "STT": "47",
    "name": "Công ty Cổ phần Chứng số An toàn",
    "MST": "0310151055",
    "homePage": "https://www.SAFEinvoice.vn",
    "lookup": ""
  },
  {
    "STT": "48",
    "name": "Công ty Cổ phần công nghệ San Phú",
    "MST": "0303430876",
    "homePage": "www.spc-technology.com",
    "lookup": "http://trahoadon.vn/SearchOne"
  },
  {
    "STT": "49",
    "name": "Công ty TNHH Giấy vi tính Liên Sơn",
    "MST": "0301452923",
    "homePage": "https://tracuu.lienson.vn",
    "lookup": "https://tracuu.lienson.vn/#/tracuuhoadon/tracuu"
  },
  {
    "STT": "50",
    "name": "Công ty TNHH Thương Mại dịch vụ Online VI NA",
    "MST": "0314185087",
    "homePage": "https://onlinevina.com.vn",
    "lookup": "https://hoadon.onlinevina.com.vn/invoice"
  },
  {
    "STT": "51",
    "name": "Công ty Cổ phần dịch vụ viễn thông và in Bưu điện",
    "MST": "0100687474",
    "homePage": "https://hoadondientu-ptp.vn",
    "lookup": "https://hoadondientu-ptp.vn/tra-cuu/"
  },
  {
    "STT": "52",
    "name": "Công ty TNHH Tuần Châu",
    "MST": "0400462489",
    "homePage": "http://e-invoicetuanchau.com",
    "lookup": "https://e-invoicetuanchau.com/Tra-cuu"
  },
  {
    "STT": "53",
    "name": "Công ty TNHH Minh Thư",
    "MST": "3500456910",
    "homePage": "https://hoadonminhthuvungtau.com",
    "lookup": "https://hoadonminhthuvungtau.com/Tra-cuu"
  },
  {
    "STT": "54",
    "name": "Công ty Cổ phần phát triển công nghệ ACMAN",
    "MST": "0104908371",
    "homePage": "https://www.acman.vn/hoa-don-dien-tu.html",
    "lookup": "https://hoadondientu.acman.vn/tra-cuu/hoa-don.html"
  },
  {
    "STT": "55",
    "name": "Công ty TNHH Tư vấn thương mại Trí Việt Luật",
    "MST": "0315191291",
    "homePage": "https://hoadonsovn.evat.vn/",
    "lookup": "https://hoadonsovn.evat.vn/"
  },
  {
    "STT": "56",
    "name": "Công ty TNHH Đầu tư Hòn Ngọc Việt",
    "MST": "0313844107",
    "homePage": "http://voice.hoadondientu.net.vn",
    "lookup": "http://voice.hoadondientu.net.vn/tra-cuu"
  },
  {
    "STT": "57",
    "name": "Công ty TNHH Dịch vụ Trí Việt Luật",
    "MST": "0311622035",
    "homePage": "http://congtyinhoadon.com ",
    "lookup": ""
  },
  {
    "STT": "58",
    "name": "Công ty Cổ phần truyền số liệu Việt Nam",
    "MST": "0106361479",
    "homePage": "https://www.ahoadon.com.vn/",
    "lookup": "https://tracuu.ahoadon.com/"
  },
  {
    "STT": "59",
    "name": "Công ty TNHH NC9 Việt Nam",
    "MST": "0312270160",
    "homePage": "https://ameinvoice.vn/home-tieng-viet/",
    "lookup": "https://ameinvoice.vn/tra-cuu-hoa-don-dien-tu/"
  },
  {
    "STT": "60",
    "name": "Công ty Cổ phần giải pháp First Trust",
    "MST": "0104493085",
    "homePage": "https://www.fts.com.vn/phan-mem-hoa-don-dien-tu/ ",
    "lookup": ""
  },
  {
    "STT": "61",
    "name": "Công ty TNHH Phần mềm Nhân Hòa",
    "MST": "0101289966",
    "homePage": "https://hoadon.biz",
    "lookup": "https://tracuu.e-hoadon.cloud/"
  },
  {
    "STT": "62",
    "name": "Công ty TNHH Kế toán và tư vấn V.L.C",
    "MST": "0303211948",
    "homePage": "https://ketoanvlc.net/",
    "lookup": ""
  },
  {
    "STT": "63",
    "name": "Công ty Cổ phần Công nghệ và giải pháp Tâm Việt",
    "MST": "0101622374",
    "homePage": "http://tamvietgroup.vn",
    "lookup": ""
  },
  {
    "STT": "64",
    "name": "Công ty TNHH Dịch vụ phần mềm AVSE",
    "MST": "0310768095",
    "homePage": "http://hoadondientu.link",
    "lookup": "http://hoadondientu.link/tracuutt78"
  },
  {
    "STT": "65",
    "name": "Công ty TNHH MTV in Bến Thành",
    "MST": "0312961577",
    "homePage": "http://benthanhinvoice.vn/",
    "lookup": "http://tracuuhoadon.benthanhinvoice.vn/"
  },
  {
    "STT": "66",
    "name": "Công ty TNHH ZAMO",
    "MST": "0313950909",
    "homePage": "https://koffi.vn",
    "lookup": "https://koffi.vn/outbound/lookup-invoice"
  },
  {
    "STT": "67",
    "name": "Công ty Cổ phần công nghệ VIETINFO",
    "MST": "0311928954",
    "homePage": "https://hddt.vietinfo.tech",
    "lookup": "https://tracuuhoadon.vietinfo.tech/"
  },
  {
    "STT": "68",
    "name": "Công ty Cổ phần phát triển phần mềm và công nghệ Bitware",
    "MST": "0103770970",
    "homePage": "http://www.bitware.vn/services/hoa-don-dien-tu/",
    "lookup": "https://www.bitware.vn/tracuuhoadon/"
  },
  {
    "STT": "69",
    "name": "Công ty Cổ phần phần mềm Rosy",
    "MST": "0305142231",
    "homePage": "https://rosysoft.vn",
    "lookup": ""
  },
  {
    "STT": "70",
    "name": "Công ty TNHH MTV thương mại dịch vụ Trần Đình Tùng",
    "MST": "3702037020",
    "homePage": "https://trandinhtung.evat.vn",
    "lookup": "https://trandinhtung.evat.vn/"
  },
  {
    "STT": "71",
    "name": "Công ty TNHH Tổng công ty Công nghệ và Giải pháp CMC",
    "MST": "0101925883",
    "homePage": "https://store.cmcts.com.vn",
    "lookup": ""
  },
  {
    "STT": "72",
    "name": "Công ty TNHH Công nghệ và tư vấn Phương Nam",
    "MST": "0316642395",
    "homePage": "https://phuongnam.evat.vn/log",
    "lookup": "https://phuongnam.evat.vn/"
  },
  {
    "STT": "73",
    "name": "Công ty TNHH Dịch vụ kế toán - Tư vấn thuế TTL",
    "MST": "0315194912",
    "homePage": "https://ttltax.com",
    "lookup": ""
  },
  {
    "STT": "74",
    "name": "Công ty Cô phần Công nghệ Phát triển hóa đơn điện tử Việt Nam",
    "MST": "0315983667",
    "homePage": "http://hoadondientuvietnam.vn",
    "lookup": ""
  },
  {
    "STT": "75",
    "name": "Công ty TNHH Phần mềm kế toán và dịch vụ thủ tục thuế Sài Gòn",
    "MST": "0310926922",
    "homePage": "https://invoice.ehcm.vn ",
    "lookup": "https://invoice.ehcm.vn/"
  },
  {
    "STT": "76",
    "name": "Công ty Cổ phần Phần mềm Thăng Long",
    "MST": "0101010702",
    "homePage": "http://thanglongsoft.com/index.php/linh-v-c-kinh-doanh/493-l-nh-va-c-kinh-doanh/493-1-l-nh-va-c-kinh-doanh",
    "lookup": ""
  },
  {
    "STT": "77",
    "name": "Công ty Cổ phần Hóa đơn điện tử TIG Thăng Long",
    "MST": "0102720409",
    "homePage": "http://tigtax.vn",
    "lookup": ""
  },
  {
    "STT": "78",
    "name": "Công ty TNHH Viễn thông Đông Sài Gòn",
    "MST": "0314058603",
    "homePage": "https://vdsg-invoice.vn/",
    "lookup": ""
  },
  {
    "STT": "79",
    "name": "Công ty Cổ phần Tin học Lạc Việt",
    "MST": "0301448733",
    "homePage": "https://accnet.vn/hoa-don-dien-tu",
    "lookup": "https://accnet.vn/hoa-don-dien-tu"
  },
  {
    "STT": "80",
    "name": "Công ty Cổ phần Công nghệ TADU",
    "MST": "0313253288",
    "homePage": "https://autoinvoice.vn",
    "lookup": ""
  },
  {
    "STT": "81",
    "name": "Công ty Cổ phần Công nghệ UNIT",
    "MST": "0309889835",
    "homePage": "https://unit.com.vn/ ",
    "lookup": ""
  },
  {
    "STT": "82",
    "name": "Công ty Cổ phần phát triển và ứng dụng phần mềm Bách Khoa",
    "MST": "0202029650",
    "homePage": "https://hoadondientu.pmbk.vn ",
    "lookup": "https://hdbk.pmbk.vn/tra-cuu-hoa-don"
  },
  {
    "STT": "83",
    "name": "Công ty Cổ phần My Software",
    "MST": "0108971656",
    "homePage": "https://mysoftware.vn ",
    "lookup": "https://tracuu.myinvoice.vn/#/"
  },
  {
    "STT": "84",
    "name": "Công ty TNHH Công nghệ HT Sài Gòn",
    "MST": "0312942260",
    "homePage": "http://ihoadondientu.net",
    "lookup": "https://ihoadondientu.net/Tracuu.aspx"
  },
  {
    "STT": "85",
    "name": "Công ty TNHH WEBCASH Việt Nam",
    "MST": "1201496252",
    "homePage": "https://einvoice.webcashvietnam.com/ ",
    "lookup": ""
  },
  {
    "STT": "86",
    "name": "Công ty TNHH Phần mềm và Tư vấn Kim Tự Tháp",
    "MST": "0303549303",
    "homePage": "https://e-invoices.vn/",
    "lookup": ""
  },
  {
    "STT": "87",
    "name": "Công ty TNHH Phần mềm BRB",
    "MST": "0311914694",
    "homePage": "http://brightbrain.vn/hoa-don-dien-tu/",
    "lookup": ""
  },
  {
    "STT": "88",
    "name": "Công ty TNHH Nhóm Mây",
    "MST": "0312617990",
    "homePage": "https://www.cloudteam.vn",
    "lookup": ""
  },
  {
    "STT": "89",
    "name": "Công ty Cổ phần Hóa đơn điện tử VININVOICE",
    "MST": "0109282176",
    "homePage": "https://vininvoice.vn",
    "lookup": "https://tracuu.vininvoice.vn/#/"
  },
  {
    "STT": "90",
    "name": "Trung tâm Tin học và Công nghệ số",
    "MST": "0102723181",
    "homePage": "http://hoadonct.gov.vn ",
    "lookup": ""
  },
  {
    "STT": "91",
    "name": "Công ty Cổ phần VETC",
    "MST": "0106858609",
    "homePage": "https://vetc.com.vn",
    "lookup": "https://tracuuhoadon.vetc.com.vn/?s"
  },
  {
    "STT": "92",
    "name": "Công ty TNHH Phần mềm PVS",
    "MST": "0315151651",
    "homePage": "https://pvssolution.com/",
    "lookup": "https://ei.pvssolution.com/#/"
  },
  {
    "STT": "93",
    "name": "Công ty Cổ phần Dịch vụ Thương mại Việt Nam trực tuyến",
    "MST": "0310151739",
    "homePage": "https://news.yoinvoice.vn",
    "lookup": "https://news.yoinvoice.vn/search-invoice"
  },
  {
    "STT": "94",
    "name": "Công ty TNHH Ecount Việt Nam",
    "MST": "0312575123",
    "homePage": "https://ecount.com ",
    "lookup": ""
  },
  {
    "STT": "95",
    "name": "Công ty Cổ phần ATIS",
    "MST": "0107732197",
    "homePage": "https://atis.com.vn/hoa-don-dien-tu ",
    "lookup": ""
  },
  {
    "STT": "96",
    "name": "Công ty Cổ phần GMO-Z.com RUNSYSTEM",
    "MST": "0101659906",
    "homePage": "https://tracuu.kaike.vn/#/",
    "lookup": "https://tracuu.kaike.vn/#/"
  },
  {
    "STT": "97",
    "name": "Công ty Cổ phần Tin học - Viễn thông Hàng không",
    "MST": "0103019524",
    "homePage": "https://aits.vn/",
    "lookup": "https://einvoice.aits.vn/"
  },
  {
    "STT": "98",
    "name": "Công ty TNHH Bizzi VietNam",
    "MST": "0316114998",
    "homePage": "https://bizzi.vn/",
    "lookup": ""
  },
  {
    "STT": "99",
    "name": "Công ty Cổ phần Công nghệ BEE",
    "MST": "0316636497",
    "homePage": "http://beetek.vn/",
    "lookup": ""
  },
  {
    "STT": "100",
    "name": "Công ty Cổ phần MONT-E",
    "MST": "0106249501",
    "homePage": "https://mont-e.com/",
    "lookup": ""
  },
  {
    "STT": "101",
    "name": "Công ty TNHH Tư vấn và Dịch vụ Home Casta",
    "MST": "0201802839",
    "homePage": "https://homecasta.vn ",
    "lookup": "https://tracuu.homecasta.vn/#/"
  },
  {
    "STT": "102",
    "name": "Công ty CP Tư vấn và Chuyển giao công nghệ Sơn Phát",
    "MST": "4601328480",
    "homePage": "https://sonphat.vn ",
    "lookup": "https://tracuuhddt78.hilo.com.vn/"
  },
  {
    "STT": "103",
    "name": "Công ty Cổ phần công nghệ KIOTVIET",
    "MST": "0104359717",
    "homePage": "https://hoadondientu.kiotviet.vn ",
    "lookup": "https://tracuuhoadon.kiotviet.vn/"
  },
  {
    "STT": "104",
    "name": "Tổng Công ty Dầu Việt Nam - CTCP (PVOIL)",
    "MST": "0305795054",
    "homePage": "https://hoadon.pvoil.vn",
    "lookup": "https://hoadon.pvoil.vn/Invoice/search"
  },
  {
    "STT": "105",
    "name": "Ngân hàng TMCP Ngoại thương Việt Nam (Vietcombank)",
    "MST": "0100112437",
    "homePage": "https://einvoice.vietcombank.com.vn",
    "lookup": "https://einvoice.vietcombank.com.vn/"
  }
];

// Các nhà cung cấp nổi bật có cơ chế định danh nhanh & hỗ trợ tự động
const KNOWN_PROVIDER_PATTERNS = [
  { match: /(viettel|vinvoice)/i, mst: '0100109106', name: 'Viettel (vInvoice)', lookup: 'https://vinvoice.viettel.vn/utilities/invoice-search', canAuto: true },
  { match: /(vnpt|vnpt-invoice)/i, mst: '0100684378', name: 'VNPT (VNPT-Invoice)', lookup: 'https://portaltool-miennam.vnpt-invoice.com.vn/', canAuto: true },
  { match: /(misa|meinvoice)/i, mst: '0101243150', name: 'MISA (meInvoice)', lookup: 'https://www.meinvoice.vn/tra-cuu/', canAuto: true },
  { match: /(bkav|ehoadon)/i, mst: '0101360697', name: 'BKAV (eHoadon)', lookup: 'https://ehoadon.vn/', canAuto: true },
  { match: /(easyinvoice|softdreams)/i, mst: '0105987432', name: 'Softdreams (EasyInvoice)', lookup: 'https://easyinvoice.vn/', canAuto: true },
  { match: /(hilo)/i, mst: '0106713804', name: 'T-VAN HILO', lookup: 'https://tracuuhddt78.hilo.com.vn/', canAuto: true },
  { match: /(thaison|einvoice\.vn)/i, mst: '0101300842', name: 'Thái Sơn (E-Invoice)', lookup: 'https://einvoice.vn/', canAuto: true },
  { match: /(fast|invoice\.fast)/i, mst: '0100779774', name: 'FAST (Fast e-Invoice)', lookup: 'https://invoice.fast.com.vn/', canAuto: true },
  { match: /(cyberbill)/i, mst: '0106880047', name: 'Cyberbill', lookup: 'https://cyberbill.vn/', canAuto: true },
  { match: /(vin-hoadon|visnam)/i, mst: '0401486901', name: 'Visnam (Vin-Hoadon)', lookup: 'https://tracuu.vin-hoadon.com/', canAuto: true },
  { match: /(vininvoice)/i, mst: '0109282176', name: 'Vininvoice', lookup: 'https://tracuu.vininvoice.vn/', canAuto: true },
  { match: /(petrolimex)/i, mst: '0100107370', name: 'Petrolimex', lookup: 'https://hoadon.petrolimex.com.vn/', canAuto: true },
  { match: /(vietcombank|vcb)/i, mst: '0100112437', name: 'Vietcombank', lookup: 'https://einvoice.vietcombank.com.vn/', canAuto: true },
  { match: /(vetc)/i, mst: '0106858609', name: 'VETC', lookup: 'https://tracuuhoadon.vetc.com.vn/', canAuto: true },
  { match: /(pvoil)/i, mst: '0305795054', name: 'PVOIL', lookup: 'https://hoadon.pvoil.vn/Invoice/search', canAuto: true }
];

class InvoiceProviderDetector {
  /**
   * Tìm thông tin nhà cung cấp theo MST
   */
  static findProviderByMst(mst) {
    if (!mst) return null;
    const cleanMst = String(mst).trim().replace(/-.*$/, ''); // lấy 10 số đầu
    return INVOICE_PROVIDERS.find(p => p.MST && (p.MST === cleanMst || p.MST.replace(/-.*$/, '') === cleanMst)) || null;
  }

  /**
   * Bóc tách thông tin tra cứu từ chuỗi XML hoặc tài liệu DOM XML
   */
  static extractLookupFromXml(xmlInput) {
    const result = {
      lookupUrl: '',
      lookupCode: '',
      providerMst: '',
      rawInfo: {}
    };

    if (!xmlInput) return result;

    let doc = null;
    let xmlText = '';

    if (typeof xmlInput === 'string') {
      xmlText = xmlInput;
      try {
        const parser = new DOMParser();
        doc = parser.parseFromString(xmlText, 'text/xml');
      } catch (_) {}
    } else if (xmlInput && xmlInput.getElementsByTagName) {
      doc = xmlInput;
    }

    // 1. Quét các thẻ TTinKhac (Thông tin khác)
    if (doc) {
      const ttinNodes = doc.getElementsByTagName('TTin');
      for (let i = 0; i < ttinNodes.length; i++) {
        const node = ttinNodes[i];
        const tagEl = node.getElementsByTagName('TTruong')[0];
        const valEl = node.getElementsByTagName('DLieu')[0];
        if (tagEl && valEl) {
          const key = (tagEl.textContent || '').trim();
          const val = (valEl.textContent || '').trim();
          if (key && val) {
            result.rawInfo[key] = val;
            const keyLower = key.toLowerCase();

            // Nhận diện Link tra cứu
            if (keyLower.includes('link') || keyLower.includes('tracuu') || keyLower.includes('portal') || keyLower.includes('url')) {
              if (val.startsWith('http://') || val.startsWith('https://')) {
                if (!result.lookupUrl) result.lookupUrl = val;
              }
            }

            // Nhận diện Mã tra cứu / Bí mật / FKey
            const normKey = keyLower.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
            if (
              normKey.includes('matracuu') || normKey.includes('manhan') || normKey.includes('mabaomat') ||
              normKey.includes('mabimat') || normKey.includes('masobimat') || normKey.includes('fkey') ||
              normKey.includes('searchcode') || normKey.includes('maxacthuc') || normKey.includes('secretcode') ||
              normKey.includes('passcode') || normKey.includes('securitycode') || normKey.includes('pin') ||
              normKey === 'code' || normKey === 'key' || normKey === 'macqt'
            ) {
              if (!result.lookupCode && !keyLower.includes('cqt')) {
                result.lookupCode = val;
              }
            }
          }
        }
      }
    }

    // 2. Dùng biểu thức chính quy RegEx bổ trợ nếu chưa thấy Link tra cứu
    if (!result.lookupUrl && xmlText) {
      const urlMatches = xmlText.match(/https?:\/\/[a-zA-Z0-9.-]+(?:\/[^\s"'<>]*)?/g);
      if (urlMatches) {
        for (const u of urlMatches) {
          const uLower = u.toLowerCase();
          if (uLower.includes('tracuu') || uLower.includes('lookup') || uLower.includes('search') ||
              uLower.includes('invoice') || uLower.includes('hoadon') || uLower.includes('vinvoice') ||
              uLower.includes('meinvoice') || uLower.includes('easyinvoice') || uLower.includes('portal')) {
            if (!uLower.includes('gdt.gov.vn') && !uLower.includes('w3.org') && !uLower.includes('xml') && !uLower.includes('schema')) {
              result.lookupUrl = u;
              break;
            }
          }
        }
      }
    }

    // 3. Quét mã tra cứu dự phòng qua RegEx nếu chưa có
    if (!result.lookupCode && xmlText) {
      const codeMatch = xmlText.match(/<TTruong>[^<]*(?:MaTraCuu|MaNhanHoaDon|FKey|MaBaoMat|MaBiMat|MasoBiMat|PassCode|Key)[^<]*<\/TTruong>(?:\s*<KDLieu>[^<]*<\/KDLieu>)?\s*<DLieu>([^<]+)<\/DLieu>/i)
        || xmlText.match(/(?:MaTraCuu|MaNhanHoaDon|FKey|MaBaoMat|MaBiMat|MasoBiMat)\s*[:=]\s*["']?([a-zA-Z0-9_-]+)["']?/i);
      if (codeMatch && codeMatch[1]) {
        result.lookupCode = codeMatch[1].trim();
      }
    }

    return result;
  }

  /**
   * Phân tích tổng thể 1 hóa đơn để trả về siêu dữ liệu NCC, Link, Mã và trạng thái hỗ trợ
   */
  static analyzeInvoice(inv, xmlText = '') {
    const rawMst = inv.msttcgp || inv.tvandnkntt || inv.nbmst || '';
    let provider = this.findProviderByMst(rawMst);

    // Trích xuất từ XML nếu có
    const xmlLookup = this.extractLookupFromXml(xmlText || inv._xmlText || '');

    let lookupUrl = xmlLookup.lookupUrl || (provider ? provider.lookup : '');
    let lookupCode = xmlLookup.lookupCode || '';

    // Nếu chưa có mã tra cứu, thử lấy từ trường ttkhac JSON nếu Cục Thuế trả về
    if (!lookupCode && inv.ttkhac) {
      try {
        const tt = typeof inv.ttkhac === 'string' ? JSON.parse(inv.ttkhac) : inv.ttkhac;
        if (Array.isArray(tt)) {
          for (const item of tt) {
            const k = (item.ttruong || item.key || '').toLowerCase();
            const v = item.dlieu || item.value || '';
            if (k.includes('matracuu') || k.includes('manhan') || k.includes('fkey') || k.includes('code')) {
              lookupCode = v;
              break;
            }
            if (!lookupUrl && (k.includes('link') || k.includes('tracuu')) && (v.startsWith('http://') || v.startsWith('https://'))) {
              lookupUrl = v;
            }
          }
        }
      } catch (_) {}
    }

    // Nhận diện theo tên miền của link tra cứu nếu chưa ra NCC
    if (!provider && lookupUrl) {
      for (const p of KNOWN_PROVIDER_PATTERNS) {
        if (p.match.test(lookupUrl)) {
          provider = {
            name: p.name,
            MST: p.mst,
            lookup: p.lookup,
            canAuto: p.canAuto
          };
          break;
        }
      }
    }

    const providerName = provider ? provider.name : (inv.msttcgp ? 'MST GP: ' + inv.msttcgp : 'Chưa xác định');
    const isKnownAuto = KNOWN_PROVIDER_PATTERNS.some(p => {
      if (provider && provider.MST && p.mst === provider.MST.replace(/-.*$/, '')) return true;
      if (lookupUrl && p.match.test(lookupUrl)) return true;
      return false;
    });

    const canDownload = isKnownAuto || !!(lookupCode && lookupUrl);

    return {
      providerName,
      providerMst: provider ? provider.MST : (inv.msttcgp || ''),
      lookupUrl: lookupUrl || '',
      lookupCode: lookupCode || '',
      canDownload,
      hasCode: !!lookupCode
    };
  }
}

if (typeof window !== 'undefined') {
  window.InvoiceProviderDetector = InvoiceProviderDetector;
  window.INVOICE_PROVIDERS = INVOICE_PROVIDERS;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { InvoiceProviderDetector, INVOICE_PROVIDERS };
}
