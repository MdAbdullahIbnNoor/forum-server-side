const express = require('express');
const app = express();
const cors = require('cors');
require('dotenv').config();
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const retry = require('retry');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require("stripe")(`${process.env.STRIPE_SECRET_KEY}`);
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.hiprwon.mongodb.net/?retryWrites=true&w=majority`;
const port = process.env.PORT || 5000;

const operation = retry.operation();

//middleware
app.use(cors());
app.use(express.json());
app.get('/', (req, res) => {
  res.send('boss is sitting')
})

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

operation.attempt(async (currentAttempt) => {
  try {
    await client.connect();
  } catch (error) {
    console.error(`Connection attempt ${currentAttempt} failed. Retrying...`);

    // Check if it's a transient error (e.g., network issue)
    if (currentAttempt < 5) {
      // Retry after a short delay (adjust the delay as needed)
      await new Promise(resolve => setTimeout(resolve, 1000));
      return;
    }

    // If it's not a transient error or exceeded retry attempts, handle the error
    console.error('Error connecting to MongoDB:', error);
    process.exit(1); // You might want to handle this differently based on your application's needs
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const userCollection = client.db("forumData").collection("users");
    const postCollection = client.db("forumData").collection("posts");
    const commentsCollection = client.db("forumData").collection("comments");
    const announcementsCollection = client.db("forumData").collection("announcements");
    const reportCollection = client.db("forumData").collection("reports");
    const paymentCollection = client.db("forumData").collection("payments");

    // jwt related api
    app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "1hr",
      });
      res.send({ token });
    });

    const verifyToken = (req, res, next) => {
      // console.log('INSIDE VERIFY TOKEN', req.headers.authorization);
      if (!req.headers.authorization) {
        return res.status(401).send({ message: 'forbidden access' });
      }
      const token = req.headers.authorization.split(' ')[1];
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (error, decoded) => {
        if (error) {
          return res.status(401).send({ message: 'forbidden access' })
        }
        req.decoded = decoded;
        next();
      })
    }

    // use verify admin after verifyToken
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      const user = await userCollection.findOne(query);
      const isAdmin = user?.role === 'admin';
      if (!isAdmin) {
        return res.status(403).send({ message: 'forbidden access' })
      }
      next();
    }

    // users related API
    app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    })

    app.get('/users/admin/:email', verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: 'unauthorized access' })
      }
      const query = { email: email }
      const user = await userCollection.findOne(query);
      let admin = false;
      if (user) {
        admin = user?.role === 'admin';
      }
      res.send({ admin });
    })

    app.post('/users', async (req, res) => {
      const user = req.body;
      // insert email if user doesn't exist:
      // you can do this many ways(1. email unique, 2. upser, 3. simple check)
      const query = { email: user.email }
      const userExists = await userCollection.findOne(query);
      if (userExists) {
        return res.send({ message: 'user already exists', insertedId: null })
      }
      const result = await userCollection.insertOne(user);
      res.send(result);
    })

    // check if the user is member
    app.get('/users/membership/:email', verifyToken, async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const user = await userCollection.findOne(query);

      if (!user) {
        return res.status(404).send({ message: 'User not found' });
      }

      const badge = user.badge || 'None';
      const postCount = user.postCount || 0;

      res.send({ badge, postCount });
    });

    app.patch('/users/member/:email', async (req, res) => {

      const userEmail = req.params.email;
      const query = { email: userEmail };
      // Now, update the user's badge to "Gold"
      const updatedDoc = {
        $set: {
          badge: 'Gold'
        }
      }
      const result = await userCollection.updateOne(query, updatedDoc);
      // Send the updated user information in the response
      res.send(result);
    })

    app.patch('/users/admin/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          role: 'admin'
        }
      }
      const result = await userCollection.updateOne(filter, updatedDoc);
      res.send(result);
    });

    app.delete('/users/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await userCollection.deleteOne(query);
      res.send(result);
    })

    // Announcement related API
    app.get('/announcements', async (req, res) => {
      const result = await announcementsCollection.find().toArray();
      res.send(result);
    });

    // posts related APIs
    app.get('/posts', async (req, res) => {
      let sortOption = req.query.sortOption || 'latest';
      let searchTerm = req.query.searchTerm || '';

      let sortQuery;
      if (sortOption === 'latest') {
        sortQuery = { time: -1 };
      } else if (sortOption === 'popularity') {
        sortQuery = { voteDifference: -1 };
      } else {
        sortQuery = { time: -1 };
      }

      const pipeline = [
        {
          $addFields: {
            voteDifference: { $subtract: ['$upVote', '$downVote'] },
          },
        },
        {
          $match: {
            tags: { $regex: searchTerm, $options: 'i' },
          },
        },
        {
          $sort: sortQuery,
        },
      ];

      try {
        const result = await postCollection.aggregate(pipeline).toArray();
        res.send(result);
      } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).send('Internal Server Error');
      }
    });

    app.get('/detailedPost/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await postCollection.findOne(query);
      res.send(result);
    });

    app.post('/posts', verifyToken, async (req, res) => {
      const userEmail = req.decoded.email;
      const query = { email: userEmail };
      const user = await userCollection.findOne(query);
  
      if (!user) {
          return res.status(404).send({ message: 'User not found' });
      }
  
      const isMember = user?.badge === 'Gold';
      const postCount = user?.postCount || 0;

      console.log(isMember, postCount);
  
      if (!isMember && postCount >= 5) {
          return res.status(403).send({ message: 'User is not a member or has exceeded the post limit' });
      }
  
      const item = req.body;
  
      try {
          // Insert the new post
          const result = await postCollection.insertOne(item);
  
          // Log the current post count before updating
          // console.log('Current post count:', postCount);
  
          // After successful post creation, increment postCount in userCollection
          const updateDoc = {
              $inc: { postCount: 1 },
          };
          await userCollection.updateOne(query, updateDoc);
  
          // Log the updated user information
          const updatedUser = await userCollection.findOne(query);
          // console.log('Updated user:', updatedUser);
  
          res.send(result);
      } catch (error) {
          console.error('Error adding post:', error);
          res.status(500).send('Internal Server Error');
      }
  });
  

    app.patch('/posts/:id', async (req, res) => {
      const postId = req.params.id;
      const { upVote, downVote } = req.body;
      const query = { _id: new ObjectId(postId) }
      const updateDoc = {
        $set: {
          upVote: upVote,
          downVote: downVote,
        }
        // $increment
      }
      const result = await postCollection.updateOne(query, updateDoc);
      console.log(upVote, downVote);
      res.send(result);
    })

    app.patch('/posts/comment-increment/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $inc: { commentsCount: 1 }, // Increment 'commentsCount' by 1
        };

        const result = await postCollection.updateOne(filter, updateDoc);
        res.send(result);
      } catch (error) {
        console.error('Error updating count:', error);
        res.status(500).send('Internal Server Error');
      }
    });


    app.get('/users/:email/posts', async (req, res) => {
      const userEmail = req.params.email;

      const posts = await postCollection
        .find({ 'author.email': userEmail })
        .sort({ time: -1 })
        .limit(3)
        .toArray();

      res.send(posts);
    });

    app.get('/users/posts', verifyToken, async (req, res) => {
      const userEmail = req.decoded.email;
    
      const posts = await postCollection
        .find({ 'author.email': userEmail })
        .sort({ time: -1 })
        .toArray();
    
      res.send(posts);
    });



    // Comments section
    app.post('/comments', async (req, res) => {
      try {
        const { userEmail, postTitle, comment } = req.body;

        // Insert the new comment into the 'comments' collection
        const result = await commentsCollection.insertOne({
          userEmail,
          postTitle,
          comment,
        });

        // Return the inserted comment
        res.send(result);
      } catch (error) {
        console.error('Error creating comment:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });

    app.get('/comments/:postTitle', async (req, res) => {
      const postTitle = req.params.postTitle;

      try {
        const comments = await commentsCollection.find({ postTitle }).toArray();
        res.send(comments);
      } catch (error) {
        console.error('Error fetching comments:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });

    // payment intent
    app.post('/create-payment-intent', async (req, res) => {
      try {
        const { price } = req.body;
        const amount = 1000; // $10 in cents

        if (isNaN(amount) || amount < 1) {
          throw new Error('Invalid amount');
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amount,
          currency: 'usd',
          payment_method_types: ['card'],
        });

        res.send({
          clientSecret: paymentIntent.client_secret
        });
      } catch (error) {
        console.error('Error creating payment intent:', error);
        res.status(400).send({ error: 'Invalid amount' });
      }
    });

    app.post('/payments', async (req, res) => {
      const payment = req.body;
      const paymentResult = await paymentCollection.insertOne(payment);

      // Handle the success scenario here

      res.send({ paymentResult });
    });

    app.get('/payments/:email', verifyToken, async (req, res) => {
      const query = { email: req.params.email }
      if (req.params.email !== req.decoded.email) {
        return res.status(403).send({ message: 'Forbidden Access' });
      }
      const result = await paymentCollection.find(query).toArray();
      res.send(result);
    });

    app.post('/payments', async (req, res) => {
      const payment = req.body;
      const paymentResult = await paymentCollection.insertOne(payment)

      // carefully delete each item from the cart
      console.log('payment ifo', payment);
      const query = {
        _id: {
          $in: payment.cartIds.map(id => new ObjectId(id))
        }
      };

      const deleteResult = await cartsCollection.deleteMany(query)
      res.send({ paymentResult, deleteResult })
    })

    app.delete('/posts/:id', verifyToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await postCollection.deleteOne(query);
      res.send(result);
    })

    // Endpoint to handle report submissions
    app.post('/reports', async (req, res) => {
      try {
          const reportData = req.body;

          // Insert the report data into the 'reportCollection'
          const result = await reportCollection.insertOne(reportData);

          // Send the result back to the client
          res.json({ success: true, insertedId: result.insertedId });
      } catch (error) {
          console.error('Error handling report:', error);
          res.status(500).json({ success: false, error: 'Internal Server Error' });
      }
  });


    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    //   await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Boss is sitting');
});

app.listen(port, () => {
  console.log(`Bistro boss is sitting on port ${port}`);
});

// Ensure that the connection is closed when the Node.js process exits
process.on('SIGINT', async () => {
  console.log('Received SIGINT. Closing MongoDB connection...');
  await client.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM. Closing MongoDB connection...');
  await client.close();
  process.exit(0);
});