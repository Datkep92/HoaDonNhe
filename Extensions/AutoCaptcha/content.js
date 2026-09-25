// Content Script - chạy trong mọi frame của trang web
// Phát hiện captcha và gửi qua Background Worker để giải

if (!window.__solvedCaptchaMap) window.__solvedCaptchaMap = {};
window.__captchaSolving = false;

function processCaptchas() {
    if (window.__captchaSolving) return;

    // Tìm TẤT CẢ ảnh captcha trên trang (Bao gồm ImageServlet và safecode sau đăng nhập)
    let imgs = document.querySelectorAll("img#image-capt, img#safecode, img[src*='getCaptcha'], img[src*='captcha'], img[src*='ImageServlet'], img[alt*='Captcha' i]");
    if (!imgs.length) return;

    // Với mỗi ảnh, tìm ô input gần nhất
    let pairs = [];
    for (let i = 0; i < imgs.length; i++) {
        let img = imgs[i];
        if (!img.offsetHeight) continue; // Ẩn

        // Tìm input captcha gần nhất (cùng container cha)
        let container = img.closest('form, .tab-pane, .modal-body, div[id]') || img.parentElement.parentElement;
        let input = container ? 
            (container.querySelector("input#captcha_code") || container.querySelector("input[name='captcha_code']") || container.querySelector("input[name='captcha']") || container.querySelector("input[name='captch']") || container.querySelector("input#CaptchaInputText") || container.querySelector("input[name='_verifyCode']") || container.querySelector("input[name='captchaCbt']") || container.querySelector("input#vcode") || container.querySelector("input[placeholder*='captcha' i]") || container.querySelector("input[placeholder*='xác nhận' i]") || container.querySelector("input[placeholder*='mã xác' i]")) 
            : null;
        
        if (!input) {
            // Fallback: tìm input gần nhất theo DOM position
            let allInputs = document.querySelectorAll("input#captcha_code, input[name='captcha_code'], input[name='captcha'], input[name='captch'], input#CaptchaInputText, input[name='_verifyCode'], input[name='captchaCbt'], input#vcode, input[placeholder*='captcha' i], input[placeholder*='xác nhận' i], input[placeholder*='mã xác' i]");
            for (let j = 0; j < allInputs.length; j++) {
                let cont2 = allInputs[j].closest('form, .tab-pane, .modal-body, div[id]');
                if (cont2 && cont2 === container) { input = allInputs[j]; break; }
            }
        }
        
        if (input) pairs.push({ img: img, input: input });
    }

    if (!pairs.length) return;

    // Lọc ra các cặp cần giải (ảnh mới hoặc input trống)
    let toSolve = [];
    for (let k = 0; k < pairs.length; k++) {
        let p = pairs[k];
        let src = p.img.src;
        if (window.__solvedCaptchaMap[src] && p.input.value) continue; // Đã giải ảnh này
        
        if (src !== (window.__solvedCaptchaMap['__last_' + k] || '')) {
            // Ảnh mới → xóa text cũ
            p.input.value = '';
            window.__solvedCaptchaMap['__last_' + k] = src;
        }
        if (!p.input.value) toSolve.push(p);
    }

    if (!toSolve.length) return;

    window.__captchaSolving = true;

    (async function() {
        try {
            for (let s = 0; s < toSolve.length; s++) {
                let pair = toSolve[s];
                try {
                    let canvas = document.createElement('canvas');
                    canvas.width = pair.img.naturalWidth || pair.img.width || 120;
                    canvas.height = pair.img.naturalHeight || pair.img.height || 38;
                    let ctx = canvas.getContext('2d');
                    ctx.drawImage(pair.img, 0, 0, canvas.width, canvas.height);
                    
                    let dataUrl = canvas.toDataURL('image/png');
                    let base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
                    if (!base64 || base64.length < 100) continue;

                    // Gửi qua Background Service Worker
                    await new Promise((resolve) => {
                        chrome.runtime.sendMessage({ type: 'SOLVE_CAPTCHA', base64: base64, pageUrl: window.location.href }, (response) => {
                            if (chrome.runtime.lastError) {
                                console.error('[AutoCaptcha] Message error:', chrome.runtime.lastError.message);
                                resolve();
                                return;
                            }

                            if (response && response.success && response.text && response.text !== 'ERROR') {
                                let isDeclPage = window.location.pathname.includes('/view-ho-so') || window.location.pathname.includes('/tk01gtgt') || window.location.pathname.includes('/tthc/tk');
                                pair.input.focus();
                                pair.input.value = response.text;
                                pair.input.dispatchEvent(new Event('input', { bubbles: true }));
                                if (!isDeclPage) {
                                    pair.input.dispatchEvent(new Event('change', { bubbles: true }));
                                }
                                window.__solvedCaptchaMap[pair.img.src] = response.text;
                                console.log('[AutoCaptcha] Đã giải captcha #' + (s+1) + ': ' + response.text);

                                // Chỉ tự động click đăng nhập nếu đang ở trang đăng nhập (không click ở các trang kê khai / nộp tờ khai)
                                let isLoginPage = window.location.pathname.includes('/login') || !!document.querySelector("#btnDangNhapLdap") || !!document.querySelector("form[action*='login']");
                                let isLoginInput = isLoginPage && !isDeclPage && (pair.input.name === 'captcha' || (pair.input.placeholder && pair.input.placeholder.toLowerCase().includes('captcha'))) && document.querySelector("input[name='tenDN']");
                                if (isLoginInput) {
                                    setTimeout(() => {
                                        let submitBtn = document.getElementById('btnDangNhapLdap');
                                        if (!submitBtn) {
                                            submitBtn = document.querySelector("[hx-on\\:click*='submitLDAP']") || document.querySelector("[onclick*='submitLDAP']");
                                        }
                                        if (!submitBtn) {
                                            let buttons = document.querySelectorAll('button.btn-primary, button.btn');
                                            for (let btn of buttons) {
                                                if (btn.textContent && btn.textContent.trim().includes('Đăng nhập') && !btn.getAttribute('hx-on:click')?.includes('submitCBT')) {
                                                    submitBtn = btn; break;
                                                }
                                            }
                                        }
                                        
                                        if (submitBtn) {
                                            console.log('[AutoCaptcha] Click nút Đăng nhập');
                                            submitBtn.click();
                                        } else if (typeof submitLDAP === 'function') {
                                            console.log('[AutoCaptcha] Gọi submitLDAP()');
                                            submitLDAP();
                                        }
                                    }, 1000);
                                }
                            } else {
                                console.log('[AutoCaptcha] Lỗi hoặc không có kết quả từ API');
                            }
                            resolve();
                        });
                    });
                } catch(e) { console.error('[AutoCaptcha] Lỗi giải #' + (s+1), e); }
            }
        } catch(e) { console.error('[AutoCaptcha]', e); }
        finally { setTimeout(function(){ window.__captchaSolving = false; }, 500); }
    })();
}

// Chạy liên tục mỗi 800ms
setInterval(processCaptchas, 800);
