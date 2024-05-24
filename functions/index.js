/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// The Cloud Functions for Firebase SDK to create Cloud Functions and triggers.
// const {logger} = require("firebase-functions");
const {onRequest} = require("firebase-functions/v2/https");
// const {onDocumentCreated} = require("firebase-functions/v2/firestore");

// The Firebase Admin SDK to access Firestore.
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} = require("@google/generative-ai");
const nodemailer = require("nodemailer");
const cors = require("cors")({origin: true});

initializeApp();

const apiKey = process.env.AI_STUDIO_API_KEY;
const genAI = new GoogleGenerativeAI(apiKey);

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD,
  },
});

const getRelevance = async (tags, allPostTags) => {
  // Initialize Gemini AI Model
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash-latest",
    // eslint-disable-next-line max-len
    systemInstruction: `You will be provided with a JSON array of tags, and your task is to sort the JSON Array according to the relevance of the tag in this JSON array: ` + tags,
  });

  const generationConfig = {
    temperature: 1,
    topP: 0.95,
    topK: 64,
    maxOutputTokens: 8192,
    responseMimeType: "application/json",
  };

  const safetySettings = [
    {
      category: HarmCategory.HARM_CATEGORY_HARASSMENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
  ];

  const chatSession = model.startChat({
    generationConfig,
    safetySettings,
  });

  const allTags = JSON.stringify(allPostTags);
  const result = await chatSession.sendMessage(allTags);
  return result.response.text();
};

exports.getUserPosts = onRequest({
  region: "asia-southeast1",
}, async (req, res) => {
  // Grab the user type and email from the request
  cors(req, res, async () => {
    const userType = req.query.userType;
    const userEmail = req.query.email;
    const query = req.query.query;
    const queryType = req.query.queryType;

    const type = userType && userType === "learner" ? "tutor" : "learner";

    const db = getFirestore();

    const users = db.collection("all_users")
        .doc(userType).collection("users");

    const posts = db.collection("createdPosts")
        .doc(`createdPost_` + type).collection("users");

    const userRef = await users.where("userEmail", "==", userEmail).get();
    const postRef = await posts.get();

    const userPosts = [];
    const userData = [];

    // Iterate over userRef to get user data.
    userRef.forEach((doc) => {
      userData.push(doc.data());
    });

    const userTags = userData[0].userTag;
    const tags = JSON.stringify(userTags);


    // Iterate over postsRef to get all user posts based on type.
    postRef.forEach((doc) => {
      console.log(doc.id, "=>", doc.data());
      userPosts.push(doc.data());
    });

    // Get all unique tags
    const allPostTags = Array.from(new Set(userPosts.reduce((acc, item) => {
      return acc.concat(item.postTags.map((tag) => tag.toLowerCase()));
    }, [])));

    console.log(`All tags: ` + allPostTags);

    // Get new order of tags based on relevance
    const customOrder = await getRelevance(tags, allPostTags);

    // Parse the result as an array
    const relevantTags = JSON.parse(customOrder);

    console.log(`Custom Order: ` + relevantTags);

    // Function to get the rank of the tag based on the order of relevance
    const getRank = (tags) => {
      for (let i = 0; i < relevantTags.length; i++) {
        if (tags.some((tag) => tag.toLowerCase() === relevantTags[i])) {
          return i;
        }
      }
      return relevantTags.length; // If no tags match, place at the end
    };

    // eslint-disable-next-line max-len
    const orderedData = userPosts.sort((a, b) => getRank(a.postTags) - getRank(b.postTags));

    const isValidDate = (dateStr) => {
      const regex = /^\d{1,2}-\d{1,2}-\d{4}$/;
      return regex.test(dateStr);
    };

    const toUTCPlus8 = (date) => {
      const utcTime = date.getTime();
      const utcPlus8Time = utcTime + 8 * 60 * 60 * 1000;
      return new Date(utcPlus8Time);
    };

    const filteredData = orderedData.filter((item) => {
      if (queryType === "topic" && query) {
        // eslint-disable-next-line max-len
        return item.postTags.some((tag) => tag.toLowerCase().startsWith(query.toLowerCase()));
      } else if (queryType === "title" && query) {
        return item.postTitle.toLowerCase().startsWith(query.toLowerCase());
      } else if (queryType === "description" && query) {
        // eslint-disable-next-line max-len
        return item.postDescription.toLowerCase().startsWith(query.toLowerCase());
      } else if (queryType === "date" && query) {
        if (!isValidDate(query)) {
          console.error("Invalid date format. Please use MM-DD-YYYY.");
          return false;
        }
        const [month, day, year] = query.split("-").map(Number);
        const searchDate = new Date(Date.UTC(year, month - 1, day));
        const searchDateUTCPlus8 = toUTCPlus8(searchDate);
        // eslint-disable-next-line max-len
        searchDateUTCPlus8.setHours(0, 0, 0, 0); // Set to the start of the day in UTC+8

        // eslint-disable-next-line max-len
        const itemDate = new Date(item.datePosted._seconds * 1000 + item.datePosted._nanoseconds / 1000000);
        const itemDateUTCPlus8 = toUTCPlus8(itemDate);
        // eslint-disable-next-line max-len
        itemDateUTCPlus8.setHours(0, 0, 0, 0); // Set to the start of the day in UTC+8

        return itemDateUTCPlus8.getTime() === searchDateUTCPlus8.getTime();
      } else {
        // No filter applied, return all items
        return true;
      }
    });

    res.json({results: filteredData});
  });
});

exports.getUsers = onRequest({
  region: "asia-southeast1",
}, async (req, res) => {
  // Grab the user type and email from the request
  cors(req, res, async () => {
    const userType = req.query.userType;
    const userEmail = req.query.email;
    const query = req.query.query;
    const queryType = req.query.queryType;

    const type = userType && userType === "learner" ? "tutor" : "learner";

    const db = getFirestore();

    const users = db.collection("all_users")
        .doc(userType).collection("users");

    const allUsers = db.collection("all_users")
        .doc(type).collection("users");

    const userRef = await users.where("userEmail", "==", userEmail).get();
    const usersRef = await allUsers.get();

    const usersArr = [];
    const userData = [];

    // Iterate over userRef to get user data.
    userRef.forEach((doc) => {
      userData.push(doc.data());
    });

    const userTags = userData[0].userTags || userData[0].userTag || [];
    const tags = JSON.stringify(userTags);

    // Iterate over postsRef to get all user posts based on type.
    usersRef.forEach((doc) => {
      console.log(doc.id, "=>", doc.data());
      usersArr.push(doc.data());
    });

    // Get all unique tags
    // eslint-disable-next-line max-len
    const allUserTags = Array.from(new Set(usersArr.reduce((acc, item) => {
      if (item.userTags) {
        acc = acc.concat(item.userTags.map((tag) => tag.toLowerCase()));
      }
      if (item.userTag) {
        acc = acc.concat(item.userTag.map((tag) => tag.toLowerCase()));
      }
      return acc;
    }, [])));

    console.log(`User tags: ` + tags);
    console.log(`All tags: ` + allUserTags);

    // Get new order of tags based on relevance
    const customOrder = await getRelevance(tags, allUserTags);

    // Parse the result as an array
    const relevantTags = JSON.parse(customOrder);

    console.log(`Custom Order: ` + relevantTags);

    // Function to get the rank of the tag based on the order of relevance
    const getRank = (tags) => {
      // Ensure tags is defined and is an array
      if (!Array.isArray(tags)) {
        return relevantTags.length; // If tags is not an array, place at the end
      }

      for (let i = 0; i < relevantTags.length; i++) {
        if (tags.some((tag) => tag.toLowerCase() === relevantTags[i])) {
          return i;
        }
      }

      return relevantTags.length; // If no tags match, place at the end
    };

    // eslint-disable-next-line max-len
    const orderedData = usersArr.sort((a, b) => {
      // Get the tags for user a and user b
      const tagsA = a.userTags || a.userTag || [];
      const tagsB = b.userTags || b.userTag || [];

      // Use getRank to compare the tags
      return getRank(tagsA) - getRank(tagsB);
    });


    const filteredData = orderedData.filter((item) => {
      if (queryType === "topic" && query) {
        // eslint-disable-next-line max-len
        return (item.userTags || item.userTag || []).some((tag) => tag.toLowerCase().startsWith(query.toLowerCase()));
      } else if (queryType === "firstName" && query) {
        return item.userFirstname.toLowerCase().startsWith(query.toLowerCase());
      } else if (queryType === "lastName" && query) {
        return item.userLastname.toLowerCase().startsWith(query.toLowerCase());
      } else if (queryType === "price" && query) {
        // Ensure the query value is at least the userSessionPrice
        // eslint-disable-next-line max-len
        return item.userSessionPrice && parseFloat(item.userSessionPrice) <= parseFloat(query);
      } else {
        // No filter applied, return all items
        return true;
      }
    });

    res.json({results: filteredData});
  });
});

exports.sendEmail = onRequest({
  region: "asia-southeast1",
}, async (req, res) => {
  cors(req, res, () => {
    // Retrieve email details from the request body
    const {to, subject, html} = req.body;

    if (!to || !subject || !html) {
      return res.status(400).send("Missing required fields");
    }

    // Setup email data
    const mailOptions = {
      from: `Matutor <${process.env.EMAIL_USER}>`,
      to: to,
      subject: subject,
      html: html,
    };

    // Send the email
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        return res.status(500).send(error.toString());
      }
      return res.status(200).send("Email sent: " + info.response);
    });
  });
});

