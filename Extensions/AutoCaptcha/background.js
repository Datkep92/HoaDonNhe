// Background Service Worker - trung gian giữa Content Script và C# API
// Content Script không thể fetch trực tiếp tới http://127.0.0.1 từ trang HTTPS
// Background worker có quyền riêng, không bị ràng buộc bởi trang web

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SOLVE_CAPTCHA') {
        handleSolveCaptcha(message)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ error: err.message }));
        return true; // Giữ kênh sendResponse mở cho async
    }
});

async function handleSolveCaptcha(message) {
    try {
        let base64Data;

        if (message.imageUrl) {
            // Fetch ảnh captcha trực tiếp từ URL (tránh tainted canvas)
            const imgResponse = await fetch(message.imageUrl, {
                credentials: 'include' // Gửi cookie session
            });
            const blob = await imgResponse.blob();
            base64Data = await blobToBase64(blob);
        } else if (message.base64) {
            base64Data = message.base64;
        } else {
            return { error: 'NO_IMAGE_DATA' };
        }

        // Gọi C# Local API Server
        const solveResponse = await fetch('http://127.0.0.1:28374/solve/', {
            method: 'POST',
            headers: {
                'X-Page-Url': message.pageUrl || ''
            },
            body: base64Data
        });

        const text = await solveResponse.text();

        if (text && text !== 'ERROR' && text.length > 0) {
            return { success: true, text: text };
        } else {
            return { error: 'SOLVE_FAILED' };
        }
    } catch (err) {
        console.error('[AutoCaptcha BG] Error:', err);
        return { error: err.message };
    }
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            // Cắt prefix "data:image/png;base64,"
            const result = reader.result;
            const commaIdx = result.indexOf(',');
            resolve(commaIdx >= 0 ? result.substring(commaIdx + 1) : result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}
