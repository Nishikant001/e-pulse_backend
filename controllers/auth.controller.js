// ==================== AUTH CONTROLLER ====================
const db = require("../models");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER, // your Gmail
    pass: process.env.EMAIL_PASS, // App Password
  },
});
exports.signup = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      tax_no,
      city,
      street1,
      street2,
      street3,
      street4,
      postal_code,
      phone_number,
      pan,
      address,
      country,
      region,
    } = req.body;

    // Check if email already exists
    const existingUser = await db.Distributor.findOne({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ message: "Email already registered" });
    }

    // Generate distributor_code (10 digits, sequential)
    const lastDistributor = await db.Distributor.findOne({
      order: [["createdAt", "DESC"]],
    });

    let newCode = "0000000001"; // Default if no distributor exists
    if (lastDistributor && lastDistributor.distributor_code) {
      const lastNum = parseInt(lastDistributor.distributor_code, 10);
      newCode = String(lastNum + 1).padStart(10, "0");
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const distributor = await db.Distributor.create({
      distributor_code: newCode,
      name,
      email,
      password: hashedPassword,
      tax_no,
      city,
      street1,
      street2,
      street3,
      street4,
      postal_code,
      phone_number,
      pan,
      address,
      country,
      region,
    });

    const safeDistributor = distributor.toJSON();
    delete safeDistributor.password;
    delete safeDistributor.reset_otp;
    delete safeDistributor.reset_otp_expiry;

    res.status(201).json({ message: "Signup successful", distributor: safeDistributor });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const distributor = await db.Distributor.findOne({ where: { email } });

    if (
      !distributor ||
      !distributor.password || // Phase 8: admin-created distributors have no login until one is set up
      !(await bcrypt.compare(password, distributor.password))
    ) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Phase 8: a deactivated (or still-pending) distributor cannot sign in. Checked only after the password is verified.
    if (distributor.status && distributor.status !== "active") {
      return res.status(403).json({ message: "Your account is not active. Please contact the administrator.", code: "DISTRIBUTOR_INACTIVE" });
    }

    // Prepare token payload
    const payload = {
      id: distributor.id,
      email: distributor.email,
      name: distributor.name,
      distributor_code: distributor.distributor_code,
    };

    // ACCESS TOKEN (short life)
    const accessToken = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    // REFRESH TOKEN (long life)
    const refreshToken = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });

    // 🍪 SEND TOKENS IN COOKIES
    res.cookie("access_token", accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 15 * 60 * 1000, // 15 min
    });

    res.cookie("refresh_token", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    // RESPONSE (NO TOKEN, NO PASSWORD/OTP IN BODY)
    const safeUser = distributor.toJSON();
    delete safeUser.password;
    delete safeUser.reset_otp;
    delete safeUser.reset_otp_expiry;

    res.json({
      message: "Login successful",
      user: safeUser,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    // Check if user exists
    const distributor = await db.Distributor.findOne({ where: { email } });

    if (!distributor) {
      return res.status(404).json({ message: "Email not found" });
    }

    // Generate 6-digit OTP (convert to string)
    const otp = String(Math.floor(100000 + Math.random() * 900000));

    // Save OTP + Expiry (15 minutes)
    distributor.reset_otp = otp;
    distributor.reset_otp_expiry = Date.now() + 15 * 60 * 1000;
    await distributor.save();

    // Send email
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "OTP for Password Reset",
      html: `
        <p>Your OTP for resetting your distributor password is:</p>
        <h2 style="font-size: 28px; letter-spacing: 3px;">${otp}</h2>
        <p>This OTP is valid for <b>15 minutes</b>. Do not share it with anyone.</p>
      `,
    });

    res.json({ message: "OTP sent to email successfully" });
  } catch (error) {
    console.error("Forgot Password Error:", error);
    res.status(500).json({ error: error.message });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    const distributor = await db.Distributor.findOne({ where: { email } });

    if (!distributor) {
      return res.status(404).json({ message: "Email not found" });
    }

    if (distributor.reset_otp !== otp) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    if (Date.now() > distributor.reset_otp_expiry) {
      return res.status(400).json({ message: "OTP expired" });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    distributor.password = hashedPassword;
    distributor.reset_otp = null;
    distributor.reset_otp_expiry = null;

    await distributor.save();

    res.json({ message: "Password reset successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;

    const distributor = await db.Distributor.findOne({ where: { email } });

    if (!distributor) {
      return res.status(404).json({ message: "Email not found" });
    }

    if (!distributor.reset_otp || !distributor.reset_otp_expiry) {
      return res.status(400).json({ message: "OTP not requested" });
    }

    // Check expiry
    if (Date.now() > distributor.reset_otp_expiry) {
      return res.status(400).json({ message: "OTP expired" });
    }

    // Check OTP
    if (distributor.reset_otp !== otp) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    res.json({ message: "OTP verified successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.refreshToken = (req, res) => {
  const refreshToken = req.cookies.refresh_token;

  if (!refreshToken) {
    return res.status(401).json({ message: "Refresh token missing" });
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);

    const newAccessToken = jwt.sign(
      {
        id: decoded.id,
        email: decoded.email,
        name: decoded.name,
        distributor_code: decoded.distributor_code,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.cookie("access_token", newAccessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 15 * 60 * 1000,
    });

    res.json({ message: "Access token refreshed" });
  } catch (err) {
    return res.status(403).json({ message: "Invalid refresh token" });
  }
};


exports.logout = (req, res) => {
  res.clearCookie("access_token");
  res.clearCookie("refresh_token");

  res.json({ message: "Logout successful" });
};
