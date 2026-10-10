'use strict';
const fs=require('node:fs'), path=require('node:path'), {execFileSync}=require('node:child_process');
const dir=path.resolve('artifacts/release-history');fs.mkdirSync(dir,{recursive:true});
const gh=args=>JSON.parse(execFileSync('gh',args,{encoding:'utf8',windowsHide:true}));
const releases=gh(['release','list','--limit','50','--json','tagName,isPrerelease']);
const summaries = {
 '1.0.8':['Thêm tab Sao kê ngân hàng: nhập Excel/CSV, đọc PDF có chữ tại máy và đối chiếu giao dịch.','Sửa bố cục bộ lọc và bảng sao kê, tránh tràn nội dung sang tab khác.'],
 '1.0.9':['Bổ sung Tổng quan: doanh thu, chi phí, biểu đồ theo tháng, hàng hóa và đối tác.','Đối chiếu sao kê với hóa đơn; tự tìm khoảng thời gian còn thiếu để đồng bộ bù.','Mở ứng dụng nhanh hơn, nhớ MST đang chọn và đồng bộ giao diện xác nhận.'],
 '1.1.0':['Dùng chung kỳ lọc cho các tab; xem hóa đơn của từng đối tác.','Bổ sung báo cáo tiền vào/tiền ra, số liệu sao kê và cải thiện tốc độ đối chiếu.','Sửa mất giao dịch trùng đặc điểm, nhập file sao kê lớn và các nút xác nhận.','Thu gọn phần đầu trang, dành thêm diện tích cho dữ liệu.'],
 '1.1.1':['Sửa nền và nội dung PDF, giảm trường hợp file trắng hoặc tải lỗi.','Mở ứng dụng nhanh hơn, kiểm tra phiên đăng nhập và đăng nhập lại khi hết phiên.','Bổ sung chạy nền cùng Windows và cải thiện trạng thái hỗ trợ.'],
 '1.1.2':['Hỗ trợ tải PDF gốc từ nhà cung cấp được hỗ trợ và bổ sung thông tin nguồn khi in.','Bổ sung thông tin tra cứu nhà cung cấp và bảng tổng hợp GTGT theo quý.','Sửa mã tra cứu, mở trang nhà cung cấp, hiển thị tiếng Việt và các lỗi giao diện.','Khả năng tải PDF gốc phụ thuộc nhà cung cấp và thông tin hóa đơn.'],
 '1.1.3':['Tích hợp trợ lý AI trong ứng dụng để đọc tài liệu, làm việc với công cụ và xuất kết quả theo quyền được cấp.','Cải thiện bảo vệ thông tin cấu hình và đóng gói tài nguyên cần thiết trong chương trình.'],
 '1.1.4':['Cải thiện nguồn AI dùng chung trong ứng dụng và luồng quản trị hỗ trợ.','Tự thử nguồn dự phòng khi nguồn đang dùng gặp lỗi; giữ cấu hình và cuộc trò chuyện.','Chat hiển thị đang xử lý, hỗ trợ ảnh/file và xuất Excel theo quyền được cấp.','Nguồn AI có thể chậm hoặc hết hạn mức; khả năng tương thích tùy dịch vụ.'],
 '1.1.5':['Gộp AI và hỗ trợ Admin vào một khung chat, giữ lịch sử theo thứ tự thời gian.','Admin có thể tiếp quản cuộc trò chuyện và trả lại cho AI; người dùng chủ động chọn tiếp tục trao đổi.','Khi AI trả lời bị ngắt, giữ nội dung đã nhận và hiển thị lý do; cải thiện thời gian phản hồi.','Mở rộng khả năng kết nối các dịch vụ AI. Nguồn miễn phí vẫn có thể hết hạn mức.'],
 '1.1.6':['Ẩn Chrome khi tải tờ khai; Đồng bộ Web mở phiên đăng nhập rồi tự ẩn lại.','Sửa ảnh CAPTCHA, lấy MST nhà cung cấp/người mua và chọn đối tác cần tra cứu.','Khi cổng tra cứu trả trang lỗi, giữ kết quả đã có và dừng khi lỗi lặp lại.','Thêm nút Liên hệ Admin, cải thiện đăng ký phiên hỗ trợ và thử lại kết nối.','Xuất Excel riêng theo bộ lọc từng tab và PDF tổng hợp quý GTGT.','Bổ sung hồ sơ kiểm tra kế toán: đối chiếu tờ khai, danh sách cần xử lý, ghi chú và đóng gói chứng từ.'],
};
for(const r of releases.filter(r=>!r.isPrerelease&&r.tagName!=='v1.1.7')) {
 const before=gh(['release','view',r.tagName,'--json','body,assets,name,tagName,url']);
 fs.writeFileSync(path.join(dir,r.tagName+'.original.json'),JSON.stringify(before,null,2));
 console.log(r.tagName+' '+before.body.length+' chars');
 const version=r.tagName.replace(/^(cntax-)?v/,''), features=summaries[version]||[];
 const notes=['# CN Tax Tools v'+version,'','Đây là bản phát hành cũ. [Tải phiên bản mới nhất](https://github.com/Datkep92/HoaDonNhe/releases/latest) để dùng các cải tiến mới.','',...(features.length?['## Điểm nổi bật của phiên bản này','',...features.map(s=>'- '+s),'']:[]),'## Tải và cài đặt','','Trong Assets, chọn **CN-Tax-Tools-Setup-v'+version+'.exe** để cài vào Windows hoặc dùng Portable. Máy cần Windows 64 bit và Chrome hoặc Edge; không cần cài Node.js.','','Giữ bản sao thư mục dữ liệu trước khi chuyển máy hoặc nâng cấp. Các file `.sha256` đi kèm dùng kiểm tra tính toàn vẹn. Những khả năng bổ sung trong phiên bản sau không áp dụng cho EXE cũ.','','[Danh sách chức năng và hướng dẫn hiện tại](https://github.com/Datkep92/HoaDonNhe#readme). Liên hệ Admin trong ứng dụng khi cần hỗ trợ.',''].join('\n');
 const file=path.join(dir,r.tagName+'.md');fs.writeFileSync(file,notes);
 if(process.argv.includes('--apply')) {
   execFileSync('gh',['release','edit',r.tagName,'--notes-file',file],{windowsHide:true,stdio:'pipe'});
   const after=gh(['release','view',r.tagName,'--json','body,assets,tagName']);
   if(after.body.trim()!==notes.trim()||JSON.stringify(after.assets)!==JSON.stringify(before.assets)||after.tagName!==before.tagName)throw Error('Release verification failed: '+r.tagName);
 }
}
