const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
//const PORT = 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const TOTAL_STORAGE_LIMIT_MB = 10240; // 10 GB limit (in MB)

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR);
}

// Security Helper: Ensures paths stay inside the uploads directory
function getSafePath(subpath = '') {
    const safePath = path.normalize(path.join(UPLOAD_DIR, subpath));
    if (!safePath.startsWith(UPLOAD_DIR)) {
        throw new Error('Unauthorized path access.');
    }
    return safePath;
}

// Helper: Calculate total size of directory recursively
function getDirectorySize(dirPath) {
    let totalSize = 0;
    const items = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const item of items) {
        const fullPath = path.join(dirPath, item.name);
        if (item.isDirectory()) {
            totalSize += getDirectorySize(fullPath);
        } else {
            const stats = fs.statSync(fullPath);
            totalSize += stats.size;
        }
    }
    return totalSize;
}

// Multer temporary storage configuration for multiple files
const upload = multer({ dest: UPLOAD_DIR });

// Email Transporter Configuration (Optional)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'your-email@gmail.com',
        pass: 'your-app-password-here'
    }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(UPLOAD_DIR));

// API: Browse folders, files, and calculate storage metrics
app.get('/api/browse', (req, res) => {
    try {
        const currentPath = req.query.path || '';
        const dirPath = getSafePath(currentPath);

        if (!fs.existsSync(dirPath)) {
            return res.json({ success: true, items: [], usedStorageMB: 0, totalStorageMB: TOTAL_STORAGE_LIMIT_MB });
        }

        // Calculate total storage used across the entire cloud
        const totalBytesUsed = getDirectorySize(UPLOAD_DIR);
        const usedStorageMB = (totalBytesUsed / (1024 * 1024)).toFixed(2);

        const items = fs.readdirSync(dirPath);
        const list = [];

        items.forEach(item => {
            const fullPath = path.join(dirPath, item);
            const stats = fs.statSync(fullPath);
            const relativeItemPath = path.join(currentPath, item).replace(/\\/g, '/');

            if (stats.isDirectory()) {
                list.push({
                    name: item,
                    type: 'folder',
                    path: relativeItemPath
                });
            } else {
                const originalName = item.includes('-') ? item.substring(item.indexOf('-') + 1) : item;
                list.push({
                    id: relativeItemPath,
                    name: originalName,
                    type: 'file',
                    size: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
                    createdAt: stats.birthtime,
                    url: '/files/' + relativeItemPath
                });
            }
        });

        res.json({
            success: true,
            items: list,
            usedStorageMB: parseFloat(usedStorageMB),
            totalStorageMB: TOTAL_STORAGE_LIMIT_MB
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// API: Create a New Folder
app.post('/api/create-folder', (req, res) => {
    try {
        const { currentPath, folderName } = req.body;
        if (!folderName) return res.status(400).json({ success: false, message: "Folder name required." });

        const newFolderPath = getSafePath(path.join(currentPath || '', folderName));
        if (fs.existsSync(newFolderPath)) {
            return res.status(400).json({ success: false, message: "Folder already exists." });
        }

        fs.mkdirSync(newFolderPath, { recursive: true });
        res.json({ success: true, message: "Folder created successfully!" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// API: Upload Multiple Files into the correct current path
app.post('/api/upload', upload.array('files'), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: "No files uploaded." });
    }

    try {
        const currentPath = req.body.currentPath || '';
        const targetDir = getSafePath(currentPath);

        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        let uploadedFileNames = [];

        for (let file of req.files) {
            const originalName = file.originalname;
            const uniqueFileName = Date.now() + '-' + originalName;
            const finalDestination = path.join(targetDir, uniqueFileName);

            fs.renameSync(file.path, finalDestination);
            uploadedFileNames.push(originalName);
        }

        const mailOptions = {
            from: 'your-email@gmail.com',
            to: 'your-email@gmail.com',
            subject: `☁️ ${req.files.length} New File(s) Uploaded to Cloud OS`,
            text: `Successfully uploaded files:\n- ${uploadedFileNames.join('\n- ')}\n\nPath: /${currentPath || 'Root'}`
        };
        transporter.sendMail(mailOptions).catch(() => {});

        res.json({ success: true, message: `${req.files.length} file(s) uploaded successfully!` });
    } catch (err) {
        req.files.forEach(file => {
            if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        });
        res.status(500).json({ success: false, message: err.message });
    }
});

// API: Rename File or Folder
app.put('/api/rename', (req, res) => {
    try {
        const { itemPath, newName } = req.body;
        if (!itemPath || !newName) return res.status(400).json({ success: false, message: "Invalid parameters." });

        const oldFullPath = getSafePath(itemPath);
        const dirName = path.dirname(itemPath);
        
        let targetNewName = newName;
        const baseName = path.basename(oldFullPath);
        if (!fs.statSync(oldFullPath).isDirectory() && baseName.includes('-')) {
            const prefix = baseName.split('-')[0];
            targetNewName = prefix + '-' + newName;
        }

        const newFullPath = getSafePath(path.join(dirName, targetNewName));

        if (fs.existsSync(newFullPath)) {
            return res.status(400).json({ success: false, message: "An item with this name already exists." });
        }

        fs.renameSync(oldFullPath, newFullPath);
        res.json({ success: true, message: "Renamed successfully!" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// API: Delete File or Folder
app.delete('/api/item', (req, res) => {
    try {
        const targetPath = req.query.path;
        if (!targetPath) return res.status(400).json({ success: false, message: "Path required." });

        const fullPath = getSafePath(targetPath);
        if (fs.existsSync(fullPath)) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            return res.json({ success: true, message: "Deleted successfully." });
        }
        res.status(404).json({ success: false, message: "Item not found." });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`[Cloud OS Active] Running at http://localhost:${PORT}`);
});